/**
 * BYOK transparency excerpt of src/routes/line.js
 *
 * Shows BYOK-related code paths in the LINE Messaging API webhook only:
 *   1. Webhook handler — free plan exemption + pre-request quota check
 *   2. getAIResponse() — decrypt → provider API call
 *   3. Post-response usage increment (same quota wallet as web chat)
 *
 * Omitted from the original line.js:
 *   - LINE signature verification (verifySignature)
 *   - system prompt construction (buildSystemPrompt)
 *   - message event routing, scenario Q&A handling
 *   - logging, rate limiters
 *
 * Read-only — this file does NOT run as-is. See README.md.
 */

const express = require('express');
const router = express.Router();
const { loadClientsConfig, loadSettings } = require('../utils/config');
const { callGeminiAPI, callGrokAPI, callChatGPTAPI, callClaudeAPI, getBotQueue } = require('../utils/ai');
const { decrypt } = require('../utils/crypto');
const db = require('../db/db');
const {
    checkQuota,
    incrementUsage,
    extractTokenUsage,
    notifyLimitReached,
    QUOTA_EXCEEDED_MESSAGE
} = require('../utils/byokQuota');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// =========================================
// getAIResponse — BYOK-relevant excerpt
// =========================================
// Same shape as chat.js BYOK paths: decrypt → provider call → fire-and-forget usage increment.

async function getAIResponse(botId, config, userMessage, systemPrompt) {
    const messages = [{ role: 'user', content: userMessage }];
    const provider = config.provider || 'google';
    const model = config.model || (provider === 'grok' ? 'grok-beta' : 'gemini-flash-latest');

    let apiResult;
    const botQueue = provider !== 'ollama' ? getBotQueue(botId) : null;
    if (botQueue) await botQueue.acquire();

    try {
        if (provider === 'grok') {
            const encryptedKey = config.apiKey || process.env.GROK_API_KEY;
            const apiKey = encryptedKey === process.env.GROK_API_KEY ? encryptedKey : decrypt(encryptedKey);
            apiResult = await callGrokAPI(apiKey, model, messages, systemPrompt);
        } else if (provider === 'openai') {
            const apiKey = decrypt(config.apiKey);
            apiResult = await callChatGPTAPI(apiKey, model, messages, systemPrompt);
        } else if (provider === 'anthropic') {
            const apiKey = decrypt(config.apiKey);
            apiResult = await callClaudeAPI(apiKey, model, messages, systemPrompt);
        } else if (provider === 'custom') {
            const apiKey = decrypt(config.apiKey);
            if (model && model.includes('grok')) {
                apiResult = await callGrokAPI(apiKey, model, messages, systemPrompt);
            } else {
                apiResult = await callGeminiAPI(apiKey, model, messages, systemPrompt);
            }
        } else if (provider === 'ollama') {
            // Local SLM — no BYOK. Omitted.
        } else {
            const encryptedKey = config.apiKey || process.env.GEMINI_API_KEY;
            const apiKey = encryptedKey === process.env.GEMINI_API_KEY ? encryptedKey : decrypt(encryptedKey);
            apiResult = await callGeminiAPI(apiKey, model, messages, systemPrompt);
        }
    } finally {
        if (botQueue) botQueue.release();
    }

    if (!apiResult || !apiResult.data || apiResult.status !== 200) {
        throw new Error('AI response failed');
    }

    // ---- [line.js] LINE-side usage increment (same wallet as web chat, fire-and-forget) ----
    if (config.byokEnabled && provider !== 'ollama') {
        const tokens = extractTokenUsage(provider, apiResult.data?.raw);
        incrementUsage(botId, tokens).then(result => {
            if (result.dailyJustCrossed) notifyLimitReached(botId, 'daily', result.state);
            if (result.monthlyJustCrossed) notifyLimitReached(botId, 'monthly', result.state);
        }).catch(e => console.error('[BYOK Quota LINE] increment error:', e.message));
    }

    return apiResult.data?.text || '申し訳ありません、応答を生成できませんでした。';
}

async function replyToLine(replyToken, text, channelToken) {
    await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${channelToken}`,
        },
        body: JSON.stringify({
            replyToken,
            messages: [{ type: 'text', text }],
        }),
    });
}

// =========================================
// Webhook handler — BYOK-relevant excerpt
// =========================================

router.post('/api/line/webhook/:botId', async (req, res) => {
    const { botId } = req.params;
    // signature verification omitted — see line.js

    const bot = await db.get('SELECT line_channel_token FROM bots WHERE bot_id = ?', [botId]);
    if (!bot) return res.status(404).end();

    const events = req.body.events || [];
    for (const event of events) {
        if (event.type !== 'message' || event.message.type !== 'text') continue;

        const userMessage = event.message.text;
        const replyToken = event.replyToken;

        const BOT_CONFIG = await loadClientsConfig();
        const config = BOT_CONFIG[botId];

        if (!config || config.status === 'suspended') {
            await replyToLine(replyToken, 'このボットは現在利用できません。', bot.line_channel_token);
            continue;
        }

        // ---- [line.js] Free plan block — BYOK users are exempt ----
        if (config.plan === 'free' && !config.byokEnabled) {
            await replyToLine(replyToken, 'このボットはフリープランのため、AIチャットは利用できません。', bot.line_channel_token);
            continue;
        }

        // ---- [line.js] BYOK quota pre-check ----
        const lineProvider = config.provider || 'google';
        if (config.byokEnabled && lineProvider !== 'ollama') {
            const quota = await checkQuota(botId);
            if (quota.blocked) {
                console.log(`[BYOK Quota LINE] Blocked bot=${botId} reason=${quota.reason}`);
                // <br> doesn't render as a newline in LINE messages → replace with \n
                const lineMsg = QUOTA_EXCEEDED_MESSAGE.replace(/<br>/g, '\n');
                await replyToLine(replyToken, lineMsg, bot.line_channel_token);
                continue;
            }
        }

        const settings = await loadSettings(botId);
        const systemPrompt = ''; // omitted — see line.js for system prompt construction

        try {
            const aiText = await getAIResponse(botId, config, userMessage, systemPrompt);
            await replyToLine(replyToken, aiText, bot.line_channel_token);
        } catch (aiErr) {
            console.error(`[LINE] Bot ${botId} AI error:`, aiErr.message);
        }
    }

    res.status(200).end();
});

module.exports = router;
