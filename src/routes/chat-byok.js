/**
 * BYOK transparency excerpt of src/routes/chat.js
 *
 * Shows the BYOK-related code paths only:
 *   1. AI source resolution (resolveAiRouting) — the bot owner explicitly selects
 *      'platform' / 'byok' / 'byom'; BYOK is used only when selected (no implicit override)
 *   2. Free plan exemption for self-funded sources (BYOK / BYOM)
 *   3. Pre-request quota check (block if over limit)
 *   4a. BYOK-Local (byok_mode='local'): the server holds NO key. The request is relayed
 *       to the owner's machine over the reverse-WS connector as a fixed semantic schema
 *       {provider, model, messages, systemPrompt, options} — no URL, no headers, no key.
 *       The connector (see connector/bot-ya-connector.js) builds the HTTP request from
 *       its own hardcoded provider table and its locally-stored key.
 *   4b. BYOK (server custody): Decrypt → provider API call
 *       (Grok / OpenAI / Anthropic / DeepSeek / Qwen / custom / Gemini)
 *   5. Post-response usage increment (fire-and-forget) + over-limit email notification.
 *      For BYOK-Local the connector reports usage in the relay's end frame, so quota
 *      tracking works identically without the key ever touching the server.
 *
 * Omitted from the original chat.js:
 *   - origin allowlist / domain check
 *   - RAG vector search (vectordb / embeddings)
 *   - knowledge base assembly / system prompt construction
 *   - Ollama branch (local SLM / BYOM reverse-WS connector relay, no BYOK)
 *   - rate limiters, logging, error handling
 *
 * Read-only — this file does NOT run as-is. See README.md.
 */

const express = require('express');
const router = express.Router();
const { loadClientsConfig } = require('../utils/config');
const { callGeminiAPI, callGrokAPI, callChatGPTAPI, callClaudeAPI, callDeepSeekAPI, callQwenAPI, getBotQueue, resolveAiRouting } = require('../utils/ai');
const { decrypt } = require('../utils/crypto');
const { isConnectorOnline, callCloudViaConnector, BYOK_LOCAL_OFFLINE_MESSAGE } = require('../utils/connectorHub');
const {
    checkQuota,
    incrementUsage,
    extractTokenUsage,
    notifyQuotaThreshold,
    QUOTA_EXCEEDED_MESSAGE
} = require('../utils/byokQuota');
const { AppError } = require('../middleware/errorHandler');

// ---- [chat.js] Provider error scrub (2026-08-18) ----
// Non-200 provider payloads are forwarded to the client (they carry the owner's
// debugging info: wrong model name, quota exhausted, etc.). Forwarding used to
// rely on the upstream assumption that providers never echo API key values in
// error payloads; that assumption is no longer load-bearing. Key-shaped strings
// are scrubbed to [REDACTED] before both the client forward and the server log.
// Payloads that cannot be JSON-serialized fall back fail-secure to a fixed message.
const PROVIDER_KEY_PATTERNS = [
    /sk-[A-Za-z0-9_-]{16,}/g,        // OpenAI (sk- / sk-proj-)・Anthropic (sk-ant-)・DeepSeek・Qwen (DashScope)
    /AIza[0-9A-Za-z_-]{20,}/g,       // Google API key
    /xai-[A-Za-z0-9_-]{16,}/g,       // xAI
    /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g // reflected Authorization headers
];
function scrubProviderError(payload) {
    try {
        let s = JSON.stringify(payload);
        if (typeof s !== 'string') return { error: 'Upstream provider error' };
        for (const re of PROVIDER_KEY_PATTERNS) s = s.replace(re, '[REDACTED]');
        return JSON.parse(s);
    } catch (e) {
        return { error: 'Upstream provider error' };
    }
}

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

        // ---- [chat.js] AI source resolution — shared with the LINE webhook ----
        // The owner explicitly selects the inference source ('platform' / 'byok' / 'byom').
        // BYOK credentials are used only when aiSource === 'byok' resolves the provider here.
        const { aiSource, provider, model, byokLocal } = resolveAiRouting(config);
        const SYSTEM_PROMPT = ''; // omitted — see chat.js for system prompt construction

        // ---- [chat.js] Free plan block — self-funded BYOK / BYOM are exempt ----
        if (config.plan === 'free' && aiSource === 'platform') {
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
            // ---- [chat.js] BYOK-Local: no key on the server — relay to the owner's machine ----
            // The payload sent over the WS is ONLY {provider, model, messages, systemPrompt,
            // options}. The server cannot specify a URL, path or headers, so even a fully
            // compromised server cannot make the connector send the key anywhere but the
            // provider hardcoded in the connector's own allowlist.
            if (byokLocal) {
                if (!isConnectorOnline(config.ownerId)) {
                    // Owner's connector app is offline → explicit offline message.
                    // Never silently falls back to the platform model.
                    return res.json({ text: BYOK_LOCAL_OFFLINE_MESSAGE });
                }
                apiResult = await callCloudViaConnector(config.ownerId, provider, model, messages, SYSTEM_PROMPT,
                    { speedPriority: !!config.byokSpeedPriority });

            // ---- [chat.js] BYOK (server custody): decrypt → provider call ----
            } else if (provider === 'grok') {
                const apiKey = decrypt(config.apiKey);
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

            } else if (provider === 'deepseek') {
                const apiKey = decrypt(config.apiKey);
                if (!apiKey) {
                    return next(new AppError("Configuration Error: DeepSeek API Key is missing.", 500));
                }
                apiResult = await callDeepSeekAPI(apiKey, model, messages, SYSTEM_PROMPT);

            } else if (provider === 'qwen') {
                const apiKey = decrypt(config.apiKey);
                if (!apiKey) {
                    return next(new AppError("Configuration Error: Qwen API Key is missing.", 500));
                }
                apiResult = await callQwenAPI(apiKey, model, messages, SYSTEM_PROMPT);

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
                // (Covers both the platform-default Ollama and BYOM: the owner's own
                //  machine reached via a reverse-WS connector. No cloud API key involved.)

            } else if (provider === 'google' || !provider) {
                const apiKey = decrypt(config.apiKey);
                if (!apiKey) {
                    return next(new AppError("Server Error: Gemini API Key not configured.", 500));
                }
                // Speed-priority toggle (owner opt-in, /api/admin/byok/speed-priority):
                // only when ON does the Gemini request carry
                // generationConfig.thinkingConfig.thinkingBudget:0 (skips the default
                // "thinking" phase of 2.5-Flash-class models). OFF sends no
                // generationConfig at all, so non-thinking models are unaffected.
                // Applied only when the owner selected BYOK as the AI source.
                apiResult = await callGeminiAPI(apiKey, model, messages, SYSTEM_PROMPT,
                    { speedPriority: aiSource === 'byok' && !!config.byokSpeedPriority });
            } else {
                return next(new AppError(`Unknown provider: ${provider}`, 500));
            }
        } finally {
            if (botQueue) botQueue.release();
        }

        if (!apiResult || !apiResult.data) {
            return next(new AppError("Provider returned empty response", 502));
        }

        if (apiResult.status !== 200) {
            // Upstream error payload is forwarded AFTER key-shape scrubbing (see
            // scrubProviderError above) — no longer trusting providers to keep key
            // values out of error payloads. See README.md "Security design choices".
            const scrubbed = scrubProviderError(apiResult.data?.raw || apiResult.data);
            console.error("Upstream API Error:", JSON.stringify(scrubbed, null, 2));
            return res.status(apiResult.status).json(scrubbed);
        }

        // ---- [chat.js] Post-response usage increment (fire-and-forget) ----
        // Staged owner email notifications: 80% warning (chat keeps running) and
        // 100% limit-reached. Each stage fires exactly once per period (0→80→100
        // ladder in byokQuota.js); a single jump past 100% skips the 80% warning.
        if (byokQuotaApplies) {
            const tokens = extractTokenUsage(provider, apiResult.data?.raw);
            incrementUsage(botId, tokens).then(result => {
                if (result.dailyCrossed) notifyQuotaThreshold(botId, 'daily', result.dailyCrossed, result.state);
                if (result.monthlyCrossed) notifyQuotaThreshold(botId, 'monthly', result.monthlyCrossed, result.state);
            }).catch(e => console.error('[BYOK Quota] increment error:', e.message));
        }

        res.json({ text: apiResult.data?.text || '' });
    } catch (e) {
        next(e);
    }
});

module.exports = router;
