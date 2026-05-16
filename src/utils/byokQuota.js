// =========================================
// BYOK Token Quota Utility
// -----------------------------------------
// - 各プロバイダー raw レスポンスからトークン使用量を抽出
// - JST 区切りで日次 / 月次の使用量を集計
// - 上限到達時のブロック判定（limit 0 = 無制限）
// - 100% 到達時のメール通知トリガー（次セッション実装予定、ここではフラグ管理のみ）
// =========================================

const db = require('../db/db');
const { sendByokLimitReachedNotification } = require('./mailer');

// ---- 推奨デフォルト値（BYOK 有効化時の初期値） ----
// 想定: gpt-4o-mini で月 $0.6 / Claude Sonnet で月 $5-10 程度に収まる安全圏
const DEFAULT_DAILY_LIMIT = 100000;
const DEFAULT_MONTHLY_LIMIT = 1000000;

// ---- JST 期間文字列ヘルパー ----
// 'YYYY-MM-DD' (JST 日) と 'YYYY-MM' (JST 月) を返す
function jstNow() {
    // UTC 現在時刻に +9h を加えて JST 相当の Date を作る（時刻計算用、表示用ではない）
    return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getJstDayKey(d = jstNow()) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getJstMonthKey(d = jstNow()) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

// ---- 各プロバイダーの raw レスポンスから total tokens を抽出 ----
function extractTokenUsage(provider, raw) {
    if (!raw || typeof raw !== 'object') return 0;
    try {
        if (provider === 'google') {
            // Gemini: { usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount } }
            return raw.usageMetadata?.totalTokenCount || 0;
        }
        if (provider === 'anthropic') {
            // Claude: { usage: { input_tokens, output_tokens } }
            const u = raw.usage;
            if (!u) return 0;
            return (u.input_tokens || 0) + (u.output_tokens || 0);
        }
        // grok / openai: OpenAI 互換 { usage: { prompt_tokens, completion_tokens, total_tokens } }
        return raw.usage?.total_tokens || 0;
    } catch (e) {
        console.warn('[byokQuota] extractTokenUsage error:', e.message);
        return 0;
    }
}

// ---- 期間判定 + リセット ----
// 現在の bots レコードを引いて、period が古ければカウンタと notified フラグをリセットしたうえで状態を返す
async function loadAndRollover(botId) {
    const bot = await db.get(
        `SELECT byok_enabled, byok_daily_limit, byok_monthly_limit,
                byok_daily_used, byok_monthly_used,
                byok_daily_period, byok_monthly_period,
                byok_daily_notified, byok_monthly_notified
         FROM bots WHERE bot_id = ?`,
        [botId]
    );
    if (!bot) return null;

    const today = getJstDayKey();
    const thisMonth = getJstMonthKey();

    let dailyUsed = bot.byok_daily_used || 0;
    let monthlyUsed = bot.byok_monthly_used || 0;
    let dailyNotified = bot.byok_daily_notified || 0;
    let monthlyNotified = bot.byok_monthly_notified || 0;

    const needDailyReset = bot.byok_daily_period !== today;
    const needMonthlyReset = bot.byok_monthly_period !== thisMonth;

    if (needDailyReset) {
        dailyUsed = 0;
        dailyNotified = 0;
        await db.run(
            'UPDATE bots SET byok_daily_used = 0, byok_daily_notified = 0, byok_daily_period = ? WHERE bot_id = ?',
            [today, botId]
        );
    }
    if (needMonthlyReset) {
        monthlyUsed = 0;
        monthlyNotified = 0;
        await db.run(
            'UPDATE bots SET byok_monthly_used = 0, byok_monthly_notified = 0, byok_monthly_period = ? WHERE bot_id = ?',
            [thisMonth, botId]
        );
    }

    return {
        byokEnabled: bot.byok_enabled === 1,
        dailyLimit: bot.byok_daily_limit || 0,
        monthlyLimit: bot.byok_monthly_limit || 0,
        dailyUsed,
        monthlyUsed,
        dailyNotified,
        monthlyNotified
    };
}

// ---- リクエスト前チェック ----
// 戻り値: { blocked: bool, reason: 'daily'|'monthly'|null, state }
async function checkQuota(botId) {
    const state = await loadAndRollover(botId);
    if (!state) return { blocked: false, reason: null, state: null };
    if (!state.byokEnabled) return { blocked: false, reason: null, state };

    // limit 0 = 無制限
    if (state.dailyLimit > 0 && state.dailyUsed >= state.dailyLimit) {
        return { blocked: true, reason: 'daily', state };
    }
    if (state.monthlyLimit > 0 && state.monthlyUsed >= state.monthlyLimit) {
        return { blocked: true, reason: 'monthly', state };
    }
    return { blocked: false, reason: null, state };
}

// ---- レスポンス後の使用量加算 ----
// tokens=0 でも記録の整合性のため呼ぶ（no-op になるだけ）
// 戻り値: { dailyJustCrossed: bool, monthlyJustCrossed: bool, state } — 100% 到達した瞬間のみ true
async function incrementUsage(botId, tokens) {
    if (!tokens || tokens <= 0) {
        return { dailyJustCrossed: false, monthlyJustCrossed: false, state: null };
    }
    // 加算前にロールオーバー判定（リクエスト直前の checkQuota から時間が空いている可能性は低いが冪等性確保）
    const before = await loadAndRollover(botId);
    if (!before) return { dailyJustCrossed: false, monthlyJustCrossed: false, state: null };

    const newDaily = before.dailyUsed + tokens;
    const newMonthly = before.monthlyUsed + tokens;

    await db.run(
        'UPDATE bots SET byok_daily_used = ?, byok_monthly_used = ? WHERE bot_id = ?',
        [newDaily, newMonthly, botId]
    );

    // 100% 到達した瞬間（このリクエストで超えた）を検出。未通知でかつ limit>0 の場合のみ true
    const dailyJustCrossed = before.dailyLimit > 0
        && before.dailyUsed < before.dailyLimit
        && newDaily >= before.dailyLimit
        && before.dailyNotified === 0;
    const monthlyJustCrossed = before.monthlyLimit > 0
        && before.monthlyUsed < before.monthlyLimit
        && newMonthly >= before.monthlyLimit
        && before.monthlyNotified === 0;

    if (dailyJustCrossed) {
        await db.run('UPDATE bots SET byok_daily_notified = 1 WHERE bot_id = ?', [botId]);
    }
    if (monthlyJustCrossed) {
        await db.run('UPDATE bots SET byok_monthly_notified = 1 WHERE bot_id = ?', [botId]);
    }

    return {
        dailyJustCrossed,
        monthlyJustCrossed,
        state: { ...before, dailyUsed: newDaily, monthlyUsed: newMonthly }
    };
}

// ---- 訪問者向け超過メッセージ（既存 queue 系の語尾と統一） ----
const QUOTA_EXCEEDED_MESSAGE = 'ごめんなさい、ただいまお返事できない状態です😢<br>少しお時間をおいてから、また話しかけてもらえると嬉しいです！';

// ---- 100% 到達時の通知トリガー（incrementUsage の戻り値で justCrossed が立った時のみ呼ぶ） ----
// メール送信は SMTP 未設定なら no-op。失敗してもチャット応答には影響させない
async function notifyLimitReached(botId, kind, state) {
    try {
        const bot = await db.get(
            `SELECT b.owner_id, b.provider, b.model, s.bot_name, s.name AS owner_name, m.email
             FROM bots b
             LEFT JOIN settings s ON b.bot_id = s.bot_id
             LEFT JOIN members m ON b.owner_id = m.id
             WHERE b.bot_id = ?`,
            [botId]
        );
        if (!bot || !bot.email) {
            console.warn(`[BYOK Quota] notify skipped bot=${botId} (no owner email)`);
            return;
        }
        const botName = bot.bot_name || bot.owner_name || botId;
        const used = kind === 'daily' ? state.dailyUsed : state.monthlyUsed;
        const limit = kind === 'daily' ? state.dailyLimit : state.monthlyLimit;
        await sendByokLimitReachedNotification(bot.email, {
            botName, kind, used, limit, provider: bot.provider, model: bot.model
        });
    } catch (e) {
        console.error('[BYOK Quota] notify error:', e.message);
    }
}

module.exports = {
    DEFAULT_DAILY_LIMIT,
    DEFAULT_MONTHLY_LIMIT,
    extractTokenUsage,
    checkQuota,
    incrementUsage,
    notifyLimitReached,
    getJstDayKey,
    getJstMonthKey,
    QUOTA_EXCEEDED_MESSAGE
};
