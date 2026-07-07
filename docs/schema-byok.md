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
| `pre_byok_api_key` | TEXT | NULL | Snapshot of `api_key` taken at activate. Used to restore state on deactivate (so the previous platform-default config is recovered exactly). |
| `pre_byok_provider` | TEXT | NULL | Snapshot of `provider` at activate. |
| `pre_byok_model` | TEXT | NULL | Snapshot of `model` at activate. |
| `byok_daily_limit` | INTEGER | 0 | Daily token cap. `0` = unlimited. Set to `DEFAULT_DAILY_LIMIT` (100,000) on first activate, preserved on re-activate if already > 0. |
| `byok_monthly_limit` | INTEGER | 0 | Monthly token cap. `0` = unlimited. Default `DEFAULT_MONTHLY_LIMIT` (1,000,000). |
| `byok_daily_used` | INTEGER | 0 | Tokens accumulated for the current day. Reset to 0 when `byok_daily_period` rolls over. |
| `byok_monthly_used` | INTEGER | 0 | Tokens accumulated for the current month. |
| `byok_daily_period` | TEXT | NULL | JST day key in `'YYYY-MM-DD'` format. Mismatch with today triggers a rollover (used = 0, notified = 0). |
| `byok_monthly_period` | TEXT | NULL | JST month key in `'YYYY-MM'` format. |
| `byok_daily_notified` | INTEGER | 0 | `1` after the 100% over-limit email has been sent for the current daily period. Cleared on rollover. |
| `byok_monthly_notified` | INTEGER | 0 | Same as `byok_daily_notified`, monthly version. |

## Lifecycle

```
[plan=free, byok_enabled=0]
        │
        │  POST /api/admin/byok/activate
        │  (provider, model, apiKey, agreedTerms)
        │
        │  ├─ normalize model id (NFKC / trim / strip "models/" / charset check)
        │  ├─ test call to provider (validates key)
        │  ├─ snapshot api_key/provider/model → pre_byok_*
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
        │  └─ incrementUsage() — fire-and-forget; 100%-cross triggers email
        │
        │  POST /api/admin/byok/deactivate
        │
        │  └─ restore api_key/provider/model from pre_byok_*
        │     clear pre_byok_*, byok_enabled = 0
        │     ai_source: 'byok' → 'platform' (never leave a broken selection)
        ▼
[plan=free, byok_enabled=0]   (limits and counters retained)
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
