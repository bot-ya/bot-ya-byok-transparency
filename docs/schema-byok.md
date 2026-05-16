# BYOK Database Schema

bot-ya stores all BYOK state on the `bots` table. Columns are added incrementally via `ALTER TABLE` migrations in `src/db/db.js` for idempotent forward-only evolution.

This document lists the BYOK-relevant columns only. Other columns (`bot_id`, `owner_id`, `plan`, basic AI settings, etc.) are omitted.

## `bots` table — BYOK columns

| Column | Type | Default | Role |
|---|---|---|---|
| `api_key` | TEXT | — | **Encrypted** API key ciphertext (format: `iv:ciphertext` hex). For BYOK-active bots this holds the user's key. For platform-default Gemini fallback, `chat.js` / `line.js` compare the value to `process.env.GEMINI_API_KEY` directly — if equal, treats it as the plain env value; otherwise decrypts. |
| `provider` | TEXT | — | `google` / `grok` / `openai` / `anthropic` / `ollama` / `custom`. |
| `model` | TEXT | — | Provider-specific model identifier. |
| `byok_enabled` | INTEGER | 0 | `1` = BYOK active. The flag also drives the free-plan exemption in `chat.js` / `line.js`. |
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
        │  ├─ test call to provider (validates key)
        │  ├─ snapshot api_key/provider/model → pre_byok_*
        │  ├─ encrypt(apiKey) → api_key
        │  ├─ byok_enabled = 1, byok_agreed_at = NOW()
        │  └─ set default daily/monthly limits if not previously set
        ▼
[byok_enabled=1, encrypted key in api_key]
        │
        │  /api/chat or LINE webhook
        │
        │  ├─ checkQuota() — block 429 if over limit
        │  ├─ decrypt(api_key) — throws if cipher corrupt
        │  ├─ provider API call (Authorization header only)
        │  └─ incrementUsage() — fire-and-forget; 100%-cross triggers email
        │
        │  POST /api/admin/byok/deactivate
        │
        │  └─ restore api_key/provider/model from pre_byok_*
        │     clear pre_byok_*, byok_enabled = 0
        ▼
[plan=free, byok_enabled=0]   (limits and counters retained)
```

## Encryption

- Algorithm: **AES-256-CBC**
- Key derivation: `sha256(ENCRYPTION_KEY)` — see `src/utils/crypto.js`
- IV: random 16 bytes per encrypt call, prepended as hex
- Storage format: `<iv hex>:<ciphertext hex>`
- Decryption failure: **throws** (no fallback). See README "Security design choices".

## JST period keys

Both rollover checks operate on string equality:

```
byok_daily_period   !== 'YYYY-MM-DD'  → daily reset
byok_monthly_period !== 'YYYY-MM'     → monthly reset
```

No cron is required. The check happens on-demand inside `loadAndRollover()` (called from `checkQuota` / `incrementUsage`). UTC-now + 9 hours produces the JST-equivalent Date for key extraction.
