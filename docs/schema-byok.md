# BYOK Database Schema

bot-ya stores all BYOK state on the `bots` table. Columns are added incrementally via `ALTER TABLE` migrations in `src/db/db.js` for idempotent forward-only evolution.

This document lists the BYOK-relevant columns only. Other columns (`bot_id`, `owner_id`, `plan`, basic AI settings, etc.) are omitted.

## `bots` table — BYOK columns

| Column | Type | Default | Role |
|---|---|---|---|
| `api_key` | TEXT | — | **Encrypted** API key ciphertext (AES-256-GCM, format: `iv:authTag:ciphertext` hex; pre-GCM rows may still be legacy CBC `iv:ciphertext`, read-only backward compat). For BYOK-active bots this holds the user's key. There is no env-var fallback — cloud keys exist only via BYOK. |
| `provider` | TEXT | — | `google` / `grok` / `openai` / `anthropic` / `deepseek` / `qwen` / `ollama` / `custom`. |
| `model` | TEXT | — | Provider-specific model identifier. Normalized on activate (NFKC, trim, strip `models/` prefix; charset-validated). |
| `byok_enabled` | INTEGER | 0 | `1` = BYOK is *available* for this bot (activated with a validated key). |
| `ai_source` | TEXT | `platform` | Which inference source the owner explicitly selected: `platform` (bot-ya default Ollama) / `byok` / `byom` (owner's own machine via reverse-WS connector). BYOK credentials are used only when this is `byok` — there is no implicit override. Also drives the free-plan exemption (`free` + `platform` = scenario Q&A only). |
| `byok_agreed_at` | DATETIME | NULL | Set to `CURRENT_TIMESTAMP` on activate. Records terms-of-use acceptance timestamp. |
| `pre_byok_api_key` | TEXT | NULL | Snapshot of `api_key` taken at the **first** activate only (`byok_enabled` 0 → 1). Used to restore state on deactivate (so the pre-BYOK platform config is recovered exactly). Re-activating while already enabled ("change settings") must NOT overwrite it — otherwise deactivate would restore the *old BYOK credentials* into the live slots with `byok_enabled=0`, silently keeping cloud calls on the old key outside quota tracking. |
| `pre_byok_provider` | TEXT | NULL | Snapshot of `provider` at activate. |
| `pre_byok_model` | TEXT | NULL | Snapshot of `model` at activate. |
| `byok_daily_limit` | INTEGER | 0 | Daily token cap. `0` = unlimited. Set to `DEFAULT_DAILY_LIMIT` (100,000) on first activate, preserved on re-activate if already > 0. |
| `byok_monthly_limit` | INTEGER | 0 | Monthly token cap. `0` = unlimited. Default `DEFAULT_MONTHLY_LIMIT` (1,000,000). |
| `byok_daily_used` | INTEGER | 0 | Tokens accumulated for the current day. Reset to 0 when `byok_daily_period` rolls over. |
| `byok_monthly_used` | INTEGER | 0 | Tokens accumulated for the current month. |
| `byok_daily_period` | TEXT | NULL | JST day key in `'YYYY-MM-DD'` format. Mismatch with today triggers a rollover (used = 0, notified = 0). |
| `byok_monthly_period` | TEXT | NULL | JST month key in `'YYYY-MM'` format. |
| `byok_daily_notified` | INTEGER | 0 | Notification ladder for the current daily period: `0` → `80` (warning email sent when usage crosses 80%; chat keeps running) → `100` (limit-reached email sent). Each stage fires exactly once (conditional-UPDATE winner takes the send); a single request jumping past 100% skips the 80% warning. Cleared on rollover. Legacy `1` (pre-staging "100% notified") is normalized to `100` by an idempotent startup migration. |
| `byok_monthly_notified` | INTEGER | 0 | Same as `byok_daily_notified`, monthly version. |
| `byok_speed_priority` | INTEGER | 0 | Owner opt-in "speed priority" toggle. When `1` and `ai_source='byok'` with a Gemini provider, requests carry a `generationConfig.thinkingConfig` that minimizes the default thinking phase, chosen by model generation: Gemini 2.x gets `thinkingBudget: 0`, Gemini 3+ gets `thinkingLevel` (`'minimal'` for Flash-class, `'low'` for Pro, which has no minimal; 3.x rejects `thinkingBudget` with 400 invalid argument). When `0`, no `generationConfig` is sent at all, so non-thinking models are unaffected. Preserved across deactivate (owner preference, like limits). |
| `byok_mode` | TEXT | `'server'` | **Key custody for this bot.** `'server'` = current encrypted server-side storage. `'local'` (**BYOK-Local**) = the key exists ONLY on the owner's machine inside the connector app; `api_key` stays empty (`''`) and the server relays a fixed semantic schema to the connector instead of calling the provider itself. Which mode a deployment offers is controlled by the `BYOK_KEY_CUSTODY` env var: `local` (bot-ya.app) permanently rejects the key-carrying `/activate` endpoint with 400, `server` (default, white-label) keeps the current behavior. |

## Lifecycle

```
[plan=free, byok_enabled=0]
        │
        │  POST /api/admin/byok/activate
        │  (provider, model, apiKey, agreedTerms)
        │
        │  ├─ normalize model id (NFKC / trim / strip "models/" / charset check)
        │  ├─ test call to provider (validates key)
        │  ├─ snapshot api_key/provider/model → pre_byok_*  (first activate only)
        │  ├─ encrypt(apiKey) → api_key
        │  ├─ byok_enabled = 1, byok_agreed_at = NOW()
        │  └─ set default daily/monthly limits if not previously set
        ▼
[byok_enabled=1, encrypted key in api_key]
        │
        │  owner selects ai_source='byok' (model tab; not implicit)
        │
        │  /api/chat or LINE webhook  — resolveAiRouting(config) picks the path
        │
        │  ├─ checkQuota() — block 429 if over limit
        │  ├─ decrypt(api_key) — throws if cipher corrupt/tampered (GCM auth tag)
        │  ├─ provider API call (Authorization header only)
        │  └─ incrementUsage() — fire-and-forget; 80%-cross triggers a warning
        │     email (chat keeps running), 100%-cross the limit-reached email
        │
        │  POST /api/admin/byok/deactivate
        │
        │  └─ restore api_key/provider/model from pre_byok_*
        │     clear pre_byok_*, byok_enabled = 0
        │     ai_source: 'byok' → 'platform' (never leave a broken selection)
        ▼
[plan=free, byok_enabled=0]   (limits and counters retained)
```

## Lifecycle — BYOK-Local (`byok_mode='local'`)

```
[byok_enabled=0]
        │
        │  browser → http://127.0.0.1:<port>/byok/key   ★ key goes ONLY here
        │  (connector app on the owner's machine tests the key against the
        │   provider and stores it in .byok-keys.json next to the exe)
        │
        │  POST /api/admin/byok/activate-local  (provider, model, agreedTerms — NO key)
        │
        │  ├─ reject if a key is accidentally included (400, not stored, not logged)
        │  ├─ reject if the owner's connector is not currently online
        │  ├─ snapshot → pre_byok_*  (first activate only, same as server mode)
        │  └─ api_key = '' , byok_enabled = 1, byok_mode = 'local'
        ▼
[byok_enabled=1, byok_mode='local', api_key='' — nothing to steal on the server]
        │
        │  /api/chat or LINE webhook
        │
        │  ├─ checkQuota() — same wallet as server mode
        │  ├─ relay {provider, model, messages, systemPrompt, options} over the
        │  │  reverse-WS connector (no URL / headers / key can be expressed)
        │  ├─ connector builds the HTTP request from its own hardcoded provider
        │  │  table + locally stored key, streams deltas back
        │  └─ incrementUsage() with the usage object the connector reports
        │
        │  connector offline → explicit offline message (no platform fallback)
        │
        │  POST /api/admin/byok/deactivate  (same endpoint as server mode)
        │  └─ restore pre_byok_*, byok_enabled = 0, byok_mode = 'server'
        ▼
[byok_enabled=0]
```

## Encryption

- Algorithm: **AES-256-GCM** (authenticated encryption — the auth tag detects ciphertext tampering)
- Key derivation: `sha256(ENCRYPTION_KEY)` — see `src/utils/crypto.js`
- IV: random 12 bytes (96-bit nonce, the GCM standard size) per encrypt call
- Storage format: `<iv hex>:<authTag hex>:<ciphertext hex>`
- Legacy: rows encrypted before the GCM upgrade use AES-256-CBC `<iv hex>:<ciphertext hex>` — still decryptable (read-only backward compat); everything written now is GCM
- Decryption failure (unrecognized format, corrupt, or failed auth tag): **throws** (no fallback). See README "Security design choices".

## JST period keys

Both rollover checks operate on string equality:

```
byok_daily_period   !== 'YYYY-MM-DD'  → daily reset
byok_monthly_period !== 'YYYY-MM'     → monthly reset
```

No cron is required. The check happens on-demand inside `loadAndRollover()` (called from `checkQuota` / `incrementUsage`). UTC-now + 9 hours produces the JST-equivalent Date for key extraction.
