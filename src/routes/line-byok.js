/**
 * BYOK transparency excerpt of src/routes/line.js
 *
 * Shows BYOK-related code paths in the LINE Messaging API webhook only:
 *   1. Webhook handler — LINE credentials decrypt (encrypted at rest, same crypto
 *      module as BYOK keys) + free plan exemption + pre-request quota check
 *   2. getAIResponse() — shared AI source resolution (resolveAiRouting, same as
 *      web chat) → decrypt → provider API call
 *   3. Post-response usage increment (same quota wallet as web chat)
 *
 * Omitted from the original line.js:
 *   - LINE signature verification internals (HMAC verifySignature; noted below)
 *   - system prompt construction (buildSystemPrompt)
 *   - message event routing, scenario Q&A handling
 *   - logging, rate limiters
 *
 * Read-only — this file does NOT run as-is. See README.md.
 */

const express = require('express');
const router = express.Router();
const { loadClientsConfig, loadSettings } = require('../utils/config');
const { callGeminiAPI, callGrokAPI, callChatGPTAPI, callClaudeAPI, callDeepSeekAPI, callQwenAPI, getBotQueue, resolveAiRouting } = require('../utils/ai');
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
// `routing` is the resolveAiRouting(config) result — the same source resolution as web chat,
// so LINE can never accidentally ignore ai_source and leak onto a different provider.

async function getAIResponse(botId, config, routing, userMessage, systemPrompt) {
    const messages = [{ role: 'user', content: userMessage }];
    const { provider, model } = routing;

    let apiResult;
    const botQueue = provider !== 'ollama' ? getBotQueue(botId) : null;
    if (botQueue) await botQueue.acquire();

    try {
        if (provider === 'grok') {
            const apiKey = decrypt(config.apiKey);
            apiResult = await callGrokAPI(apiKey, model, messages, systemPrompt);
        } else if (provider === 'openai') {
            const apiKey = decrypt(config.apiKey);
            apiResult = await callChatGPTAPI(apiKey, model, messages, systemPrompt);
        } else if (provider === 'anthropic') {
            const apiKey = decrypt(config.apiKey);
            apiResult = await callClaudeAPI(apiKey, model, messages, systemPrompt);
        } else if (provider === 'deepseek') {
            const apiKey = decrypt(config.apiKey);
            apiResult = await callDeepSeekAPI(apiKey, model, messages, systemPrompt);
        } else if (provider === 'qwen') {
            const apiKey = decrypt(config.apiKey);
            apiResult = await callQwenAPI(apiKey, model, messages, systemPrompt);
        } else if (provider === 'custom') {
            const apiKey = decrypt(config.apiKey);
            if (model && model.includes('grok')) {
                apiResult = await callGrokAPI(apiKey, model, messages, systemPrompt);
            } else {
                apiResult = await callGeminiAPI(apiKey, model, messages, systemPrompt);
            }
        } else if (provider === 'ollama') {
            // Local SLM — no BYOK. Omitted.
            // (Covers both the platform-default Ollama and BYOM: the owner's own
            //  machine reached via a reverse-WS connector. No cloud API key involved.)
        } else if (provider === 'google' || !provider) {
            const apiKey = decrypt(config.apiKey);
            apiResult = await callGeminiAPI(apiKey, model, messages, systemPrompt);
        } else {
            throw new Error(`Unknown provider: ${provider}`);
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

    const bot = await db.get('SELECT line_channel_token, line_channel_secret FROM bots WHERE bot_id = ?', [botId]);
    if (!bot || !bot.line_channel_token || !bot.line_channel_secret) return res.status(404).end();

    // LINE credentials are encrypted at rest (same crypto module as BYOK keys).
    // Decrypt before signature verification / replying.
    const channelToken = decrypt(bot.line_channel_token);
    const channelSecret = decrypt(bot.line_channel_secret);
    // HMAC-SHA256 signature verification with channelSecret (timing-safe compare,
    // fail-closed on missing/invalid signature) — internals omitted, see line.js

    const events = req.body.events || [];
    for (const event of events) {
        if (event.type !== 'message' || event.message.type !== 'text') continue;

        const userMessage = event.message.text;
        const replyToken = event.replyToken;

        const BOT_CONFIG = await loadClientsConfig();
        const config = BOT_CONFIG[botId];

        if (!config || config.status === 'suspended') {
            await replyToLine(replyToken, 'このボットは現在利用できません。', channelToken);
            continue;
        }

        // ---- [line.js] AI source resolution — same helper as web chat ----
        const routing = resolveAiRouting(config);

        // ---- [line.js] Free plan block — self-funded BYOK / BYOM are exempt ----
        if (config.plan === 'free' && routing.aiSource === 'platform') {
            await replyToLine(replyToken, 'このボットはフリープランのため、AIチャットは利用できません。', channelToken);
            continue;
        }

        // ---- [line.js] BYOK quota pre-check ----
        if (config.byokEnabled && routing.provider !== 'ollama') {
            const quota = await checkQuota(botId);
            if (quota.blocked) {
                console.log(`[BYOK Quota LINE] Blocked bot=${botId} reason=${quota.reason}`);
                // <br> doesn't render as a newline in LINE messages → replace with \n
                const lineMsg = QUOTA_EXCEEDED_MESSAGE.replace(/<br>/g, '\n');
                await replyToLine(replyToken, lineMsg, channelToken);
                continue;
            }
        }

        const settings = await loadSettings(botId);
        const systemPrompt = ''; // omitted — see line.js for system prompt construction

        try {
            const aiText = await getAIResponse(botId, config, routing, userMessage, systemPrompt);
            await replyToLine(replyToken, aiText, channelToken);
        } catch (aiErr) {
            console.error(`[LINE] Bot ${botId} AI error:`, aiErr.message);
        }
    }

    res.status(200).end();
});

module.exports = router;
