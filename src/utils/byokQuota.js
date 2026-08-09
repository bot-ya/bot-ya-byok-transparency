// =========================================
// BYOK Token Quota Utility
// -----------------------------------------
// - 各プロバイダー raw レスポンスからトークン使用量を抽出
// - JST 区切りで日次 / 月次の使用量を集計
// - 上限到達時のブロック判定（limit 0 = 無制限）
// - 80% / 100% 到達時のメール通知トリガー（notified は 0→80→100 の階段値）
// =========================================

const db = require('../db/db');
const { sendByokLimitReachedNotification, sendByokLimitWarningNotification } = require('./mailer');

// ---- 推奨デフォルト値（BYOK 有効化時の初期値） ----
// 想定: gpt-4o-mini で月 $0.6 / Claude Sonnet で月 $5-10 程度に収まる安全圏
const DEFAULT_DAILY_LIMIT = 100000;
const DEFAULT_MONTHLY_LIMIT = 1000000;

// ---- 段階通知のしきい値 ----
// notified フラグは 0 → 80 → 100 の階段値（各段で1回だけメール）。
// 1リクエストで 80% を飛び越えて 100% に達した場合は 100 のみ通知する。
const WARN_RATIO = 0.8;

// 加算後の使用量が属する通知段（0 = 通知なし帯）
function notifyLevelFor(used, limit) {
    if (limit <= 0) return 0; // 無制限
    if (used >= limit) return 100;
    if (used >= limit * WARN_RATIO) return 80;
    return 0;
}

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
// 戻り値: { dailyCrossed: 0|80|100, monthlyCrossed: 0|80|100, state }
//   — その通知段に「今回の加算で初めて」到達したリクエストだけが 80/100 を受け取る
async function incrementUsage(botId, tokens) {
    if (!tokens || tokens <= 0) {
        return { dailyCrossed: 0, monthlyCrossed: 0, state: null };
    }
    // 加算前にロールオーバー判定（リクエスト直前の checkQuota から時間が空いている可能性は低いが冪等性確保）
    const before = await loadAndRollover(botId);
    if (!before) return { dailyCrossed: 0, monthlyCrossed: 0, state: null };

    // 加算は SQL 側で行う（アトミック）。JS で計算した値を書き戻す方式だと、
    // bot キューが許す同時リクエスト（最大3）の完了が重なったとき加算がロストし
    // 過少カウントになる。加算後の実値は読み直して返す。
    await db.run(
        'UPDATE bots SET byok_daily_used = byok_daily_used + ?, byok_monthly_used = byok_monthly_used + ? WHERE bot_id = ?',
        [tokens, tokens, botId]
    );
    const after = await db.get(
        'SELECT byok_daily_used, byok_monthly_used FROM bots WHERE bot_id = ?',
        [botId]
    );
    const newDaily = after ? after.byok_daily_used : before.dailyUsed + tokens;
    const newMonthly = after ? after.byok_monthly_used : before.monthlyUsed + tokens;

    // 段階通知（80% / 100%）: 加算後の値が属する通知段より notified が小さい行だけを
    // その段まで引き上げる条件付き UPDATE。changes=1 を取れた 1 リクエストだけが通知を
    // 担う（同時到達での 2 重送信防止）。80% を飛び越えて 100% に達したら 100 のみ。
    const dailyCrossed = await claimNotifyLevel(botId, 'daily', notifyLevelFor(newDaily, before.dailyLimit));
    const monthlyCrossed = await claimNotifyLevel(botId, 'monthly', notifyLevelFor(newMonthly, before.monthlyLimit));

    return {
        dailyCrossed,
        monthlyCrossed,
        state: { ...before, dailyUsed: newDaily, monthlyUsed: newMonthly }
    };
}

// notified フラグを level まで引き上げる。勝者（changes=1）だけが level を返し、
// 既に同段以上が立っていれば 0（通知不要）。
async function claimNotifyLevel(botId, kind, level) {
    if (level <= 0) return 0;
    const column = kind === 'daily' ? 'byok_daily_notified' : 'byok_monthly_notified';
    const r = await db.run(
        `UPDATE bots SET ${column} = ? WHERE bot_id = ? AND ${column} < ?`,
        [level, botId, level]
    );
    return r.changes === 1 ? level : 0;
}

// ---- 訪問者向け超過メッセージ（既存 queue 系の語尾と統一） ----
const QUOTA_EXCEEDED_MESSAGE = 'ごめんなさい、ただいまお返事できない状態です😢<br>少しお時間をおいてから、また話しかけてもらえると嬉しいです！';

// ---- 80% / 100% 到達時の通知トリガー（incrementUsage の戻り値で crossed が立った時のみ呼ぶ） ----
// level: 80（予告・チャットは継続中） or 100（到達・チャット停止中）
// メール送信は SMTP 未設定なら no-op。失敗してもチャット応答には影響させない
async function notifyQuotaThreshold(botId, kind, level, state) {
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
        const payload = { botName, kind, used, limit, provider: bot.provider, model: bot.model };
        if (level === 100) {
            await sendByokLimitReachedNotification(bot.email, payload);
        } else {
            await sendByokLimitWarningNotification(bot.email, payload);
        }
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
    notifyQuotaThreshold,
    getJstDayKey,
    getJstMonthKey,
    QUOTA_EXCEEDED_MESSAGE
};
