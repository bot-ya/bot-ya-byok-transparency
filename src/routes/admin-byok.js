/**
 * BYOK transparency excerpt of src/routes/admin.js
 *
 * This file shows the BYOK admin endpoints only:
 *   - GET  /api/admin/byok/status
 *   - POST /api/admin/byok/activate
 *   - POST /api/admin/byok/deactivate
 *   - POST /api/admin/byok/speed-priority
 *   - GET  /api/admin/byok/usage
 *   - POST /api/admin/byok/limits
 *   - POST /api/admin/byok/reset-counter
 *
 * Surrounding scaffolding (multer banner upload, bot CRUD, member management,
 * super-admin endpoints, etc.) is omitted from the original admin.js.
 *
 * Read-only — this file does NOT run as-is. See README.md.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { encrypt, decrypt } = require('../utils/crypto');
const { callGeminiAPI, callGrokAPI, callChatGPTAPI, callClaudeAPI, callDeepSeekAPI, callQwenAPI, normalizeModelId } = require('../utils/ai');
const {
    DEFAULT_DAILY_LIMIT,
    DEFAULT_MONTHLY_LIMIT,
    getJstDayKey,
    getJstMonthKey,
    checkQuota
} = require('../utils/byokQuota');

// =========================================
// BYOK (Bring Your Own Key) APIs
// =========================================

router.get('/api/admin/byok/status', requireAuth, async (req, res, next) => {
    try {
        const botId = req.botId;
        const row = await db.get("SELECT byok_enabled, provider, model, byok_speed_priority FROM bots WHERE bot_id = ?", [botId]);
        if (!row) return next(new AppError("Bot not found", 404));
        res.json({
            byokEnabled: row.byok_enabled === 1,
            provider: row.byok_enabled === 1 ? row.provider : '',
            model: row.byok_enabled === 1 ? row.model : '',
            speedPriority: row.byok_speed_priority === 1
        });
    } catch (e) {
        next(e);
    }
});

router.post('/api/admin/byok/activate', requireAuth, async (req, res, next) => {
    try {
        const botId = req.botId;
        const { provider, model, apiKey, agreedTerms } = req.body;

        if (!agreedTerms) {
            return next(new AppError("利用規約への同意が必要です", 400));
        }
        if (!provider || !model || !apiKey) {
            return next(new AppError("プロバイダー、モデル名、APIキーは必須です", 400));
        }
        if (!['google', 'grok', 'openai', 'anthropic', 'deepseek', 'qwen'].includes(provider)) {
            return next(new AppError("対応プロバイダーはGoogle、Grok、ChatGPT、Claude、DeepSeek、Qwenのみです", 400));
        }

        // 表示名（"Gemini 3 Flash" 等）やドキュメントからのコピペ（models/ 付き・全角混入）を吸収
        const normalizedModel = normalizeModelId(model);
        if (!normalizedModel) {
            return next(new AppError("モデル名の形式が不正です。「Gemini 3 Flash」のような表示名ではなく、モデルID（例: gemini-3-flash-preview）を入力してください。", 400));
        }

        const bot = await db.get("SELECT api_key, provider, model, byok_enabled FROM bots WHERE bot_id = ?", [botId]);
        if (!bot) return next(new AppError("Bot not found", 404));

        const testHistory = [{ role: "user", content: "Hello" }];
        try {
            const testCallers = {
                google: callGeminiAPI,
                grok: callGrokAPI,
                openai: callChatGPTAPI,
                anthropic: callClaudeAPI,
                deepseek: callDeepSeekAPI,
                qwen: callQwenAPI
            };
            const result = await testCallers[provider](apiKey, normalizedModel, testHistory, "Reply with OK");
            if (result.status && result.status >= 400) {
                const errMsg = result.data?.error?.message || JSON.stringify(result.data);
                console.error('[BYOK] Test call failed:', result.status, errMsg);
                return next(new AppError(`接続テストに失敗しました: ${errMsg}`, 400));
            }
        } catch (testErr) {
            console.error('[BYOK] Test call error:', testErr.message);
            return next(new AppError("APIキーまたはモデル名が無効です。接続テストに失敗しました。", 400));
        }

        // pre_byok_* は「BYOK 導入前の状態」の退避スロット。保存するのは初回 activate
        // （byok_enabled=0 → 1 の遷移）のみ。BYOK 有効中の「設定変更」再 activate で
        // 上書きすると、退避値が旧 BYOK 認証情報になり、deactivate 時にそれが
        // api_key/provider/model へ復元されて byok_enabled=0 のままクラウド API を
        // quota 外で呼び続ける事故になる（platform 選択のつもりが旧キー課金）。
        if (!bot.byok_enabled) {
            await db.run(
                "UPDATE bots SET pre_byok_api_key = api_key, pre_byok_provider = provider, pre_byok_model = model WHERE bot_id = ?",
                [botId]
            );
        }

        const encryptedKey = encrypt(apiKey);
        await db.run(
            "UPDATE bots SET api_key = ?, provider = ?, model = ?, byok_enabled = 1, byok_agreed_at = CURRENT_TIMESTAMP WHERE bot_id = ?",
            [encryptedKey, provider, normalizedModel, botId]
        );

        // [BYOK Quota] 初回 activate なら推奨デフォルト値をセット、期間/カウンタ/通知フラグはクリーンスタート
        // 既にユーザー設定済みの上限値（>0）は保持する（再有効化のたびに上限値が初期化されない）
        const today = getJstDayKey();
        const thisMonth = getJstMonthKey();
        const existing = await db.get(
            'SELECT byok_daily_limit, byok_monthly_limit FROM bots WHERE bot_id = ?',
            [botId]
        );
        const dailyLimit = (existing && existing.byok_daily_limit > 0)
            ? existing.byok_daily_limit
            : DEFAULT_DAILY_LIMIT;
        const monthlyLimit = (existing && existing.byok_monthly_limit > 0)
            ? existing.byok_monthly_limit
            : DEFAULT_MONTHLY_LIMIT;
        await db.run(
            `UPDATE bots SET byok_daily_limit = ?, byok_monthly_limit = ?,
                             byok_daily_used = 0, byok_monthly_used = 0,
                             byok_daily_period = ?, byok_monthly_period = ?,
                             byok_daily_notified = 0, byok_monthly_notified = 0
             WHERE bot_id = ?`,
            [dailyLimit, monthlyLimit, today, thisMonth, botId]
        );

        // model は正規化済みの保存値を返す（フロントは入力値でなくこれを表示に使う）
        res.json({ success: true, message: "BYOK有効化に成功しました", model: normalizedModel });
    } catch (e) {
        next(e);
    }
});

router.post('/api/admin/byok/deactivate', requireAuth, async (req, res, next) => {
    try {
        const botId = req.botId;
        const bot = await db.get(
            "SELECT byok_enabled, pre_byok_api_key, pre_byok_provider, pre_byok_model FROM bots WHERE bot_id = ?",
            [botId]
        );
        if (!bot) return next(new AppError("Bot not found", 404));

        // 冪等: BYOK 有効でない時は no-op（活きてる api_key/provider/model を絶対に上書きしない）
        if (!bot.byok_enabled) {
            return res.json({ success: true, message: "BYOKは既に無効です" });
        }

        // byok_enabled=1 なら activate を経由している → pre_byok_* を NULL/空文字含めそのまま復元。
        // 旧コードは pre_byok_api_key を falsy 判定して provider/model まで空クリアしていた
        // （Free ユーザーの初期 api_key='' で誤動作するバグ）。activate 直前の状態に戻すのが正。
        // 使用中ソースが BYOK だったら bot屋既定(platform)へフォールバック（凍結: 壊れた選択を作らない）
        await db.run(
            "UPDATE bots SET api_key = ?, provider = ?, model = ?, byok_enabled = 0, pre_byok_api_key = NULL, pre_byok_provider = NULL, pre_byok_model = NULL, ai_source = CASE WHEN ai_source = 'byok' THEN 'platform' ELSE ai_source END WHERE bot_id = ?",
            [bot.pre_byok_api_key, bot.pre_byok_provider, bot.pre_byok_model, botId]
        );
        res.json({ success: true, message: "BYOKを無効化しました" });
    } catch (e) {
        next(e);
    }
});

// 応答速度優先トグル（候補8）: ON のときだけ Gemini リクエストに thinkingBudget:0 を送り、
// 2.5 Flash 系のデフォルト thinking（初動1〜2秒の上乗せ）を切る。thinking 非対応モデルでは
// エラーになり得るため一律適用はせず、オーナーの明示 ON に閉じる。設定は deactivate 後も
// 保持する（上限値と同じ「オーナーの好み」扱い。効くのは BYOK 選択時のみ）。
router.post('/api/admin/byok/speed-priority', requireAuth, async (req, res, next) => {
    try {
        const botId = req.botId;
        const { enabled } = req.body || {};
        if (typeof enabled !== 'boolean') {
            return next(new AppError("enabled は true / false で指定してください", 400));
        }
        const bot = await db.get("SELECT byok_enabled FROM bots WHERE bot_id = ?", [botId]);
        if (!bot) return next(new AppError("Bot not found", 404));

        await db.run(
            'UPDATE bots SET byok_speed_priority = ? WHERE bot_id = ?',
            [enabled ? 1 : 0, botId]
        );
        res.json({ success: true, speedPriority: enabled });
    } catch (e) {
        next(e);
    }
});

// =========================================
// BYOK Token Quota APIs
// =========================================

// 現在の使用量と上限を取得（管理画面の使用量バー表示用）
// checkQuota を呼ぶことでロールオーバー判定が走り、期間が古ければカウンタがリセットされた状態で返る
router.get('/api/admin/byok/usage', requireAuth, async (req, res, next) => {
    try {
        const botId = req.botId;
        const quota = await checkQuota(botId);
        if (!quota.state) return next(new AppError("Bot not found", 404));

        const row = await db.get(
            'SELECT byok_daily_period, byok_monthly_period FROM bots WHERE bot_id = ?',
            [botId]
        );
        res.json({
            byokEnabled: quota.state.byokEnabled,
            dailyLimit: quota.state.dailyLimit,
            monthlyLimit: quota.state.monthlyLimit,
            dailyUsed: quota.state.dailyUsed,
            monthlyUsed: quota.state.monthlyUsed,
            dailyPeriod: row?.byok_daily_period || null,
            monthlyPeriod: row?.byok_monthly_period || null,
            dailyNotified: quota.state.dailyNotified === 1 || quota.state.dailyNotified === true,
            monthlyNotified: quota.state.monthlyNotified === 1 || quota.state.monthlyNotified === true,
            blocked: quota.blocked,
            blockedReason: quota.reason
        });
    } catch (e) {
        next(e);
    }
});

// 上限値の更新。limit 0 = 無制限。負の値は不可
router.post('/api/admin/byok/limits', requireAuth, async (req, res, next) => {
    try {
        const botId = req.botId;
        const { dailyLimit, monthlyLimit } = req.body;

        const d = Number(dailyLimit);
        const m = Number(monthlyLimit);
        if (!Number.isFinite(d) || !Number.isFinite(m) || d < 0 || m < 0 || !Number.isInteger(d) || !Number.isInteger(m)) {
            return next(new AppError("上限値は 0 以上の整数で指定してください", 400));
        }

        await db.run(
            'UPDATE bots SET byok_daily_limit = ?, byok_monthly_limit = ? WHERE bot_id = ?',
            [d, m, botId]
        );
        res.json({ success: true, message: "上限値を更新しました", dailyLimit: d, monthlyLimit: m });
    } catch (e) {
        next(e);
    }
});

// 手動リセット。kind: 'daily' | 'monthly' | 'both'
router.post('/api/admin/byok/reset-counter', requireAuth, async (req, res, next) => {
    try {
        const botId = req.botId;
        const { kind } = req.body;
        if (!['daily', 'monthly', 'both'].includes(kind)) {
            return next(new AppError("kind は 'daily' / 'monthly' / 'both' のいずれかを指定してください", 400));
        }

        const today = getJstDayKey();
        const thisMonth = getJstMonthKey();
        if (kind === 'daily' || kind === 'both') {
            await db.run(
                'UPDATE bots SET byok_daily_used = 0, byok_daily_notified = 0, byok_daily_period = ? WHERE bot_id = ?',
                [today, botId]
            );
        }
        if (kind === 'monthly' || kind === 'both') {
            await db.run(
                'UPDATE bots SET byok_monthly_used = 0, byok_monthly_notified = 0, byok_monthly_period = ? WHERE bot_id = ?',
                [thisMonth, botId]
            );
        }
        res.json({ success: true, message: "カウンタをリセットしました", kind });
    } catch (e) {
        next(e);
    }
});

module.exports = router;
