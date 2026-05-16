/**
 * BYOK transparency excerpt of src/routes/chat.js
 *
 * Shows the BYOK-related code paths only:
 *   1. Free plan exemption for BYOK users
 *   2. Pre-request quota check (block if over limit)
 *   3. Decrypt → provider API call (Grok / OpenAI / Anthropic / custom / Gemini)
 *   4. Post-response usage increment (fire-and-forget) + over-limit email notification
 *
 * Omitted from the original chat.js:
 *   - origin allowlist / domain check
 *   - RAG vector search (vectordb / embeddings)
 *   - knowledge base assembly / system prompt construction
 *   - Ollama branch (local SLM, no BYOK)
 *   - rate limiters, logging, error handling
 *
 * Read-only — this file does NOT run as-is. See README.md.
 */

const express = require('express');
const router = express.Router();
const { loadClientsConfig } = require('../utils/config');
const { callGeminiAPI, callGrokAPI, callChatGPTAPI, callClaudeAPI, getBotQueue } = require('../utils/ai');
const { decrypt } = require('../utils/crypto');
const {
    checkQuota,
    incrementUsage,
    extractTokenUsage,
    notifyLimitReached,
    QUOTA_EXCEEDED_MESSAGE
} = require('../utils/byokQuota');
const { AppError } = require('../middleware/errorHandler');

// =========================================
// /api/chat handler — BYOK-relevant excerpt
// =========================================

router.post('/api/chat', async (req, res, next) => {
    try {
        const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
        const botId = req.body.botId || 'default';

        const BOT_CONFIG = await loadClientsConfig();
        const config = BOT_CONFIG[botId];
        if (!config) return next(new AppError("Bot ID not found.", 404));

        const provider = config.provider || 'google';
        const model = config.model;
        const SYSTEM_PROMPT = ''; // omitted — see chat.js for system prompt construction

        // ---- [chat.js] Free plan block — BYOK users are exempt ----
        if (config.plan === 'free' && !config.byokEnabled) {
            return next(new AppError("フリープランではAIチャットは利用できません。シナリオQ&Aをご利用ください。", 403));
        }

        // ---- [chat.js] BYOK quota pre-check ----
        // Cloud API providers (=BYOK active) only. Ollama is excluded (self-hosted, free).
        const byokQuotaApplies = config.byokEnabled && provider !== 'ollama';
        if (byokQuotaApplies) {
            const quota = await checkQuota(botId);
            if (quota.blocked) {
                console.log(`[BYOK Quota] Blocked bot=${botId} reason=${quota.reason}`);
                return next(new AppError(QUOTA_EXCEEDED_MESSAGE, 429));
            }
        }

        let apiResult;
        const botQueue = provider !== 'ollama' ? getBotQueue(botId) : null;
        if (botQueue) await botQueue.acquire();

        try {
            // ---- [chat.js] BYOK decrypt → provider call ----
            if (provider === 'grok') {
                const encryptedKey = config.apiKey || process.env.GROK_API_KEY;
                // If the stored value equals the env (platform default), use as-is (plain env value).
                // Otherwise decrypt (BYOK user-provided ciphertext).
                const apiKey = encryptedKey === process.env.GROK_API_KEY ? encryptedKey : decrypt(encryptedKey);
                if (!apiKey) {
                    return next(new AppError("Server Error: Grok API Key not configured.", 500));
                }
                apiResult = await callGrokAPI(apiKey, model, messages, SYSTEM_PROMPT);

            } else if (provider === 'openai') {
                const encryptedKey = config.apiKey;
                const apiKey = decrypt(encryptedKey);
                if (!apiKey) {
                    return next(new AppError("Configuration Error: OpenAI API Key is missing.", 500));
                }
                apiResult = await callChatGPTAPI(apiKey, model, messages, SYSTEM_PROMPT);

            } else if (provider === 'anthropic') {
                const encryptedKey = config.apiKey;
                const apiKey = decrypt(encryptedKey);
                if (!apiKey) {
                    return next(new AppError("Configuration Error: Anthropic API Key is missing.", 500));
                }
                apiResult = await callClaudeAPI(apiKey, model, messages, SYSTEM_PROMPT);

            } else if (provider === 'custom') {
                // [SECURITY] Strict BYOK Enforcement
                const encryptedKey = config.apiKey;
                const apiKey = decrypt(encryptedKey);
                if (!apiKey) {
                    return next(new AppError("Configuration Error: Custom API Key is missing.", 400));
                }
                // Dynamic Provider Inference for BYOK
                if (model && model.includes('grok')) {
                    apiResult = await callGrokAPI(apiKey, model, messages, SYSTEM_PROMPT);
                } else {
                    apiResult = await callGeminiAPI(apiKey, model, messages, SYSTEM_PROMPT);
                }

            } else if (provider === 'ollama') {
                // Local SLM branch — no BYOK, no quota. Omitted.

            } else {
                // Default: Google (platform default env or BYOK ciphertext)
                const encryptedKey = config.apiKey || process.env.GEMINI_API_KEY;
                const apiKey = encryptedKey === process.env.GEMINI_API_KEY ? encryptedKey : decrypt(encryptedKey);

                if (!apiKey || apiKey.includes('your_api_key')) {
                    return next(new AppError("Server Error: Gemini API Key not valid.", 500));
                }
                apiResult = await callGeminiAPI(apiKey, model, messages, SYSTEM_PROMPT);
            }
        } finally {
            if (botQueue) botQueue.release();
        }

        if (!apiResult || !apiResult.data) {
            return next(new AppError("Provider returned empty response", 502));
        }

        if (apiResult.status !== 200) {
            // NOTE: Upstream provider error response is forwarded as-is.
            // This relies on each provider (OpenAI / Anthropic / Gemini / xAI) not including
            // API key values in error payloads. See README.md "Security design choices".
            console.error("Upstream API Error:", JSON.stringify(apiResult.data?.raw || apiResult.data, null, 2));
            return res.status(apiResult.status).json(apiResult.data?.raw || apiResult.data);
        }

        // ---- [chat.js] Post-response usage increment (fire-and-forget) ----
        // 100%-crossed → owner email notification triggered here.
        if (byokQuotaApplies) {
            const tokens = extractTokenUsage(provider, apiResult.data?.raw);
            incrementUsage(botId, tokens).then(result => {
                if (result.dailyJustCrossed) notifyLimitReached(botId, 'daily', result.state);
                if (result.monthlyJustCrossed) notifyLimitReached(botId, 'monthly', result.state);
            }).catch(e => console.error('[BYOK Quota] increment error:', e.message));
        }

        res.json({ text: apiResult.data?.text || '' });
    } catch (e) {
        next(e);
    }
});

module.exports = router;
