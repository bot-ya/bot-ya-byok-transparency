#!/usr/bin/env node
// bot-ya コネクタ (BYOM 方式 B)
//
// オーナーのマシンで動かす最小クライアント。bot-ya サーバーへ *外向き* に
// WebSocket を 1 本張り、bot-ya から来た推論リクエストをローカル Ollama
// (localhost:11434) に転送して応答を返す。
//
// これで「クラウドの bot-ya から、NAT 内の自宅 PC の Ollama」へ、
// 公開 URL もインバウンド開放もなしに到達できる。
//
// 使い方（リポジトリのルートから実行 = node_modules の ws を解決するため）:
//   BOTYA_URL=http://localhost:3000 BOTYA_TOKEN=<接続キー> node connector/bot-ya-connector.js
//   （本番なら BOTYA_URL=https://bot-ya.app）
//   OLLAMA_URL を変えればローカル Ollama の場所も変更可（既定 http://localhost:11434）
//
// 接続キー（BOTYA_TOKEN）は、管理画面 BYOM タブの「接続キー（このマシン専用）」で発行する
// 専用デバイストークン（B-3）。会員パスワード/セッションとは別物で、AI の中継だけに使われる。
// 認証は WS ハンドシェイクの Authorization ヘッダーで送る（URL クエリに載せない＝
// アクセスログ/中間装置にキーが残らない。サーバーは旧コネクタ互換でクエリも受理する）。
//
// 中継は許可リスト方式: サーバーが指定できるのは ALLOWED_REQUESTS の組み合わせだけ。
// 万一サーバー側が侵害されても、このマシンから任意 URL/任意 API へは到達できない
// （BYOK-Local 構想の絶対条件「汎用プロキシ禁止」の先取り）。
//
// このファイルは「単一exe(Node SEA)」のソースでもある（B-3 ①②③）:
//   `npm run build:connector` で Node なしで動く Windows 単一 exe にビルドし、管理画面の
//   「接続アプリをダウンロード」が exe + 専用 .token + install.bat 等を zip で配布する。
//   exe として動くときは .token を exe 本体の隣（process.execPath のフォルダ）から読む。
// 残（B-3 後続）: コード署名（SmartScreen 回避）/ tray アイコン / Mac 版。

const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const CONNECTOR_VERSION = '1.1.0'; // BYOK-Local (cloud key relay) 対応版

const BOTYA_URL = process.env.BOTYA_URL || 'http://localhost:3000';

// .token を探す基準ディレクトリ。
// - 単一exe(Node SEA / B-3) で動いているときは __dirname が仮想パスになり隣の .token を
//   見つけられないので、exe 本体の場所(process.execPath のフォルダ)を基準にする。
// - dev（node connector/bot-ya-connector.js で直接実行）では従来どおり __dirname。
// SEA 判定は node:sea.isSea()。dev でも node:sea は存在し isSea()=false を返すので安全。
let tokenBaseDir = __dirname;
try {
    const sea = require('node:sea');
    if (sea && sea.isSea && sea.isSea()) tokenBaseDir = path.dirname(process.execPath);
} catch (_) { /* node:sea が無い古い実行系では __dirname のまま */ }

// トークンは 環境変数 > 第1引数 > <exe/スクリプトの隣>/.token (gitignore 済み) の順で解決。
// ファイル読みは trim() で BOM/改行を落とす（notepad 保存の CRLF 等に強くする）。
let BOTYA_TOKEN = process.env.BOTYA_TOKEN || process.argv[2];
if (!BOTYA_TOKEN) {
    try {
        const t = fs.readFileSync(path.join(tokenBaseDir, '.token'), 'utf8').trim();
        if (t) BOTYA_TOKEN = t;
    } catch (_) { /* ファイルが無ければ無視（下の未設定チェックで弾く）*/ }
}
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const CONNECTOR_PATH = '/api/byom/connector';
const RECONNECT_MS = 3000;
const KEEPALIVE_MS = 20000;  // この間隔で cping を送る（Cloudflare のアイドル切断を防ぐ）
const DEAD_AFTER_MS = 60000; // cpong がこの時間途絶えたらハーフオープンとみなし張り直す

// 中継を許可するリクエストの組み合わせ（メソッド + パス完全一致）。
// これ以外はサーバーから何を指示されても実行しない（汎用プロキシ化の禁止）。
// /v1/chat/completions は旧サーバー互換のため残す（どちらもローカル Ollama のチャット面）。
const ALLOWED_REQUESTS = [
    { method: 'GET', path: '/api/tags' },
    { method: 'POST', path: '/api/chat' },
    { method: 'POST', path: '/v1/chat/completions' }
];
function isAllowedRequest(method, reqPath) {
    const m = (method || 'POST').toUpperCase();
    return ALLOWED_REQUESTS.some(a => a.method === m && a.path === reqPath);
}

// サーバー都合の恒久的クローズコード。再接続しても同じ結果になるだけなので、
// 明快なメッセージを出して停止する（旧実装は 3 秒ごとに永久リトライしてしまっていた）。
const FATAL_CLOSES = {
    4000: '別のマシンのコネクタに接続が置き換えられました。このコネクタは停止します（1アカウント1接続）。',
    4001: '接続キーが無効です。管理画面の「ローカルAI（BYOM）」タブで接続アプリをダウンロードし直してください（新しいキーが同梱されます）。',
    4002: '接続キーが失効しました（再発行または切断操作が行われました）。管理画面から接続アプリをダウンロードし直してください。'
};

if (!BOTYA_TOKEN) {
    console.error('[connector] BOTYA_TOKEN が未設定です。接続キーを環境変数 BOTYA_TOKEN か第1引数で渡すか、.token ファイルを隣に置いてください。');
    process.exit(1);
}

// ==========================================================================
// BYOK-Local（完全ローカル鍵）
// --------------------------------------------------------------------------
// クラウド AI の API キーを bot-ya サーバーに預けず、このマシンにだけ保存する。
// キーは管理画面のブラウザから 127.0.0.1 の受け口へ直送され（サーバー不通過）、
// チャット時はサーバーが意味論リクエスト {kind:'cloud_chat', provider, model,
// messages, systemPrompt, options} だけを WS で送ってくる。HTTP リクエストの
// 組み立て（宛先 URL・認証ヘッダー・ボディ形）は 100% この固定表が行い、
// サーバーから URL/パス/ヘッダーは一切受け取らない（汎用プロキシ禁止の絶対条件。
// 万一サーバーが侵害されても、キーの窃取や任意 URL への送信は構造的に不可能）。
// ==========================================================================

// --- キー保存: .token と同じ流儀で exe/スクリプトの隣に置く -----------------
// provider 毎に 1 本: { "google": "AIza...", "openai": "sk-..." }
// BOTYA_KEYS_DIR はテストハーネス用の差し込みフック（オーナー自身の env）。
const KEYS_DIR = process.env.BOTYA_KEYS_DIR || tokenBaseDir;
const KEYS_FILE = path.join(KEYS_DIR, '.byok-keys.json');
const LOCAL_PORT = parseInt(process.env.BOTYA_LOCAL_PORT, 10) || 41930;
// このマシン独自の中継天井（サーバー完全侵害でも超えられない防御レイヤー）
const CLOUD_RATE_LIMIT_PER_MIN = parseInt(process.env.BOTYA_CLOUD_RATE_LIMIT, 10) || 30;
const CLOUD_TIMEOUT_MS = 120000;

let cloudKeys = {};
try {
    const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cloudKeys = parsed;
} catch (_) { /* 無ければ空でよい */ }

function persistCloudKeys() {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(cloudKeys, null, 2));
}

// モデルIDの許可文字（サーバー utils/ai.js normalizeModelId と同一）。
// Gemini はモデルIDが URL パスに入るため、URL 注入の封鎖として必須の検証。
const MODEL_ID_RE = /^[A-Za-z0-9._:-]+$/;

// --- プロバイダー固定表 -----------------------------------------------------
// エンドポイント/リクエスト形/usage 捕捉はサーバー側 utils/ai.js のストリーム
// アダプターと同一に保つこと（乖離すると Web と BYOK-Local で挙動がズレる）。
// BOTYA_CLOUD_TEST_BASE はモックプロバイダー差し込み用（テストハーネス専用）。
const CLOUD_TEST_BASE = process.env.BOTYA_CLOUD_TEST_BASE || null;
const cloudBase = (prodBase) => (CLOUD_TEST_BASE || prodBase).replace(/\/$/, '');

// OpenAI 互換（openai / grok / deepseek / qwen）: Bearer + /chat/completions
const openAICompatibleProvider = (prodBase) => ({
    build(apiKey, model, messages, systemPrompt, options) {
        return {
            url: `${cloudBase(prodBase)}/chat/completions`,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: {
                messages: [{ role: 'system', content: systemPrompt }, ...messages],
                model,
                stream: true,
                temperature: 0.7,
                // 最終チャンクに usage を含めさせる（サーバー側 quota 集計用）
                stream_options: { include_usage: true }
            }
        };
    },
    // SSE イベント 1 件からテキスト delta を取り出す。usage を含む最終 raw は
    // state.raw に集める（サーバーの extractTokenUsage が読む形状）。
    delta(data, state) {
        if (data.usage) state.raw = data;
        return (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) || null;
    }
});

// 速度優先の thinkingConfig をモデル世代で出し分ける（src/utils/ai.js の
// speedThinkingConfig と同一ロジックのミラー — 変更時は両方を同期すること）。
// Gemini 3 系以降は thinkingBudget が 400 になるため thinkingLevel
// （Flash 系='minimal' / Pro='low'）、2.x とバージョン不明は従来の thinkingBudget:0。
const speedThinkingConfig = (model) => {
    const m = /^gemini-(\d+)/.exec(String(model || '').trim());
    const major = m ? parseInt(m[1], 10) : 0;
    if (major >= 3) {
        return { thinkingLevel: /pro/i.test(model) ? 'low' : 'minimal' };
    }
    return { thinkingBudget: 0 };
};

const CLOUD_PROVIDERS = {
    google: {
        build(apiKey, model, messages, systemPrompt, options) {
            const contents = messages.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }));
            if (contents.length > 0 && contents[0].role === 'user') {
                contents[0].parts[0].text = systemPrompt + '\n\n' + contents[0].parts[0].text;
            }
            const body = { contents };
            if (options.speedPriority) {
                body.generationConfig = { thinkingConfig: speedThinkingConfig(model) };
            }
            return {
                // キーはクエリでなくヘッダーで送る（アクセスログ/中間装置にキーを残さない）
                url: `${cloudBase('https://generativelanguage.googleapis.com')}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body
            };
        },
        delta(data, state) {
            state.raw = data; // 最終イベントに累計 usageMetadata が載る
            const cand = data.candidates && data.candidates[0];
            const parts = cand && cand.content && cand.content.parts;
            if (!parts) return null;
            const text = parts.map(p => p.text || '').join('');
            return text || null;
        }
    },
    anthropic: {
        build(apiKey, model, messages, systemPrompt, options) {
            return {
                url: `${cloudBase('https://api.anthropic.com')}/v1/messages`,
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: { model, max_tokens: 1024, system: systemPrompt, messages, stream: true }
            };
        },
        delta(data, state) {
            if (!state.raw) state.raw = { usage: { input_tokens: 0, output_tokens: 0 } };
            if (data.type === 'message_start') {
                state.raw.usage.input_tokens = (data.message && data.message.usage && data.message.usage.input_tokens) || 0;
            } else if (data.type === 'message_delta') {
                if (data.usage && data.usage.output_tokens != null) state.raw.usage.output_tokens = data.usage.output_tokens;
            } else if (data.type === 'content_block_delta') {
                return (data.delta && data.delta.text) || null;
            }
            return null;
        }
    },
    openai: openAICompatibleProvider('https://api.openai.com/v1'),
    grok: openAICompatibleProvider('https://api.x.ai/v1'),
    deepseek: openAICompatibleProvider('https://api.deepseek.com/v1'),
    qwen: openAICompatibleProvider('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
};

// クラウド SSE の "data: {json}" 行をパース（[DONE]/空行/event: 行は無視）
function parseCloudSseLine(line) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return null;
    const jsonStr = trimmed.slice(5).trim();
    if (jsonStr === '[DONE]') return null;
    try { return JSON.parse(jsonStr); } catch (_) { return null; }
}

// 中継レート天井（直近 60 秒のスライディングウィンドウ）
const cloudCallTimes = [];
function cloudRateExceeded() {
    const now = Date.now();
    while (cloudCallTimes.length && now - cloudCallTimes[0] > 60000) cloudCallTimes.shift();
    if (cloudCallTimes.length >= CLOUD_RATE_LIMIT_PER_MIN) return true;
    cloudCallTimes.push(now);
    return false;
}

// WS 経由で受けた messages をローカルで再構築（role は user/assistant のみ、content は文字列必須）
function sanitizeChatMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const out = [];
    for (const m of messages) {
        if (!m || typeof m.content !== 'string') return null;
        out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
    return out;
}

// クラウドへ 1 リクエストを投げ、delta テキストを onChunk へ逐次渡す。
// 戻り値は usage を含む最終 raw。行分断は持ち越しバッファ、マルチバイト分断は
// StringDecoder で復元（Ollama 中継と同じ堅牢化）。
// opts.stopAfterFirstEvent: キーの接続テスト用（認証+モデル妥当性が証明できた時点で
// 中断し、トークン消費を最小にする）。
async function runCloudChat(provider, apiKey, model, messages, systemPrompt, options, onChunk, opts = {}) {
    const prov = CLOUD_PROVIDERS[provider];
    const { url, headers, body } = prov.build(apiKey, model, messages, systemPrompt, options || {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
        if (!resp.ok) {
            const errText = await resp.text();
            let message = `${provider} API error ${resp.status}`;
            try {
                const parsed = JSON.parse(errText);
                const m = (parsed.error && parsed.error.message) || parsed.message;
                if (m) message += `: ${m}`;
            } catch (_) { if (errText) message += `: ${errText.slice(0, 300)}`; }
            const e = new Error(message);
            e.status = resp.status;
            throw e;
        }
        const state = { raw: null };
        let events = 0;
        const handleLine = (line) => {
            const data = parseCloudSseLine(line);
            if (!data) return;
            events++;
            const text = prov.delta(data, state);
            if (text && onChunk) onChunk(text);
        };
        let buffer = '';
        const utf8Decoder = new StringDecoder('utf8');
        let stoppedEarly = false;
        for await (const part of resp.body) {
            buffer += utf8Decoder.write(Buffer.from(part));
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) handleLine(line);
            if (opts.stopAfterFirstEvent && events > 0) { stoppedEarly = true; break; }
        }
        if (stoppedEarly) {
            controller.abort(); // 接続テストは最初のイベントで十分＝以降を読まずに切る
        } else {
            buffer += utf8Decoder.end();
            handleLine(buffer);
        }
        return state.raw;
    } finally {
        clearTimeout(timer);
    }
}

// WS の cloud_chat リクエスト処理（許可リスト検証 → 手元のキーで中継）
async function handleCloudChatRequest(msg) {
    const fail = (error) => {
        if (msg.stream) send({ t: 'err', id: msg.id, error });
        else send({ t: 'res', id: msg.id, ok: false, error });
    };
    const p = msg.payload || {};
    const provider = p.provider;
    if (!CLOUD_PROVIDERS[provider]) {
        console.warn(`[connector] blocked cloud_chat for non-allowlisted provider: ${provider}`);
        return fail('このプロバイダーは許可されていません');
    }
    const model = typeof p.model === 'string' ? p.model : '';
    if (!MODEL_ID_RE.test(model)) return fail('モデルIDが不正です');
    const messages = sanitizeChatMessages(p.messages);
    if (!messages) return fail('messages が不正です');
    const systemPrompt = typeof p.systemPrompt === 'string' ? p.systemPrompt : '';
    // options はホワイトリストで再構築（サーバーから任意フィールドを受け流さない）
    const options = { speedPriority: !!(p.options && p.options.speedPriority) };
    const apiKey = cloudKeys[provider];
    if (!apiKey) {
        return fail(`このマシンに ${provider} の API キーが保存されていません。管理画面の BYOK タブでキーを保存してください。`);
    }
    if (cloudRateExceeded()) {
        console.warn(`[connector] cloud rate limit exceeded (${CLOUD_RATE_LIMIT_PER_MIN}/min)`);
        return fail(`このマシンのクラウド中継レート上限（${CLOUD_RATE_LIMIT_PER_MIN}回/分）に達しました。少し待ってから再度お試しください。`);
    }
    try {
        if (msg.stream) {
            const raw = await runCloudChat(provider, apiKey, model, messages, systemPrompt, options,
                (text) => send({ t: 'chunk', id: msg.id, data: text }));
            send({ t: 'end', id: msg.id, meta: { raw } });
            console.log(`[connector] cloud_chat streamed ${provider}/${model} -> done`);
        } else {
            let full = '';
            const raw = await runCloudChat(provider, apiKey, model, messages, systemPrompt, options,
                (text) => { full += text; });
            send({ t: 'res', id: msg.id, ok: true, status: 200, data: { text: full || null, raw } });
            console.log(`[connector] cloud_chat relayed ${provider}/${model} -> 200`);
        }
    } catch (e) {
        console.error(`[connector] cloud_chat error (${provider}/${model}): ${e.message}`);
        fail(e.message);
    }
}

// --- ローカル HTTP 受け口（キー受領・write-only）----------------------------
// 127.0.0.1 のみ bind。管理画面（BOTYA_URL のオリジン）のブラウザからキーを
// 直接受け取る＝キーがサーバーを通らない唯一の入口。設計の要点:
//   - write-only: キー素材を返すエンドポイントは存在しない（/health は保有真偽のみ）
//   - Origin 固定: BOTYA_URL 以外のオリジンからのブラウザリクエストは 403
//   - Host 検証: DNS rebinding（evil.com を 127.0.0.1 に解決させる攻撃）を遮断
//   - PNA: Chrome の Private Network Access プリフライトに応答
function startLocalKeyServer() {
    let allowedOrigin = null;
    try { allowedOrigin = new URL(BOTYA_URL).origin; } catch (_) {}

    const server = http.createServer((req, res) => {
        const origin = req.headers.origin;
        const sendJson = (status, obj) => {
            const headers = { 'Content-Type': 'application/json; charset=utf-8' };
            if (origin && origin === allowedOrigin) {
                headers['Access-Control-Allow-Origin'] = origin;
                headers['Vary'] = 'Origin';
            }
            res.writeHead(status, headers);
            res.end(JSON.stringify(obj));
        };

        const host = (req.headers.host || '').replace(/:\d+$/, '');
        if (host !== '127.0.0.1' && host !== 'localhost') {
            return sendJson(403, { ok: false, message: 'forbidden host' });
        }
        if (origin && origin !== allowedOrigin) {
            console.warn(`[connector] blocked local request from origin: ${origin}`);
            return sendJson(403, { ok: false, message: 'forbidden origin' });
        }

        if (req.method === 'OPTIONS') {
            if (!origin || origin !== allowedOrigin) return sendJson(403, { ok: false });
            res.writeHead(204, {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Private-Network': 'true',
                'Access-Control-Max-Age': '600',
                'Vary': 'Origin'
            });
            return res.end();
        }

        if (req.method === 'GET' && req.url === '/health') {
            const providers = {};
            for (const name of Object.keys(CLOUD_PROVIDERS)) providers[name] = !!cloudKeys[name];
            return sendJson(200, { ok: true, version: CONNECTOR_VERSION, providers });
        }

        if (req.method === 'POST' && req.url === '/byok/key') {
            let raw = '';
            req.on('data', (c) => {
                raw += c;
                if (raw.length > 64 * 1024) req.destroy(); // キー+メタで十分すぎるサイズ上限
            });
            req.on('end', async () => {
                let body = null;
                try { body = JSON.parse(raw); } catch (_) {}
                const provider = body && body.provider;
                const apiKey = (body && typeof body.apiKey === 'string') ? body.apiKey.trim() : '';
                const model = (body && typeof body.model === 'string') ? body.model.trim() : '';
                if (!CLOUD_PROVIDERS[provider]) return sendJson(400, { ok: false, message: '不明なプロバイダーです' });
                if (!apiKey) return sendJson(400, { ok: false, message: 'APIキーを入力してください' });
                if (!MODEL_ID_RE.test(model)) return sendJson(400, { ok: false, message: 'モデルIDが不正です' });
                // 保存前にこのマシンから直接プロバイダーへテスト呼び出し（キーの正しさを実証してから保存）
                try {
                    await runCloudChat(provider, apiKey, model,
                        [{ role: 'user', content: 'こんにちは' }],
                        '接続テストです。一言だけ返答してください。',
                        {}, null, { stopAfterFirstEvent: true });
                } catch (e) {
                    return sendJson(200, { ok: false, status: e.status, message: `接続テストに失敗しました: ${e.message}` });
                }
                cloudKeys[provider] = apiKey;
                try {
                    persistCloudKeys();
                } catch (e) {
                    delete cloudKeys[provider];
                    return sendJson(500, { ok: false, message: `キーの保存に失敗しました: ${e.message}` });
                }
                console.log(`[connector] cloud key saved for ${provider} (${KEYS_FILE})`);
                return sendJson(200, { ok: true, provider });
            });
            return;
        }

        const delMatch = req.method === 'DELETE' && /^\/byok\/key\/([a-z]+)$/.exec(req.url || '');
        if (delMatch) {
            const provider = delMatch[1];
            if (cloudKeys[provider]) {
                delete cloudKeys[provider];
                try {
                    persistCloudKeys();
                } catch (e) {
                    return sendJson(500, { ok: false, message: `キーの削除に失敗しました: ${e.message}` });
                }
                console.log(`[connector] cloud key deleted for ${provider}`);
            }
            return sendJson(200, { ok: true }); // 冪等: 無くても成功
        }

        return sendJson(404, { ok: false, message: 'not found' });
    });

    server.on('error', (e) => {
        console.warn(`[connector] ローカル受け口(127.0.0.1:${LOCAL_PORT})を開けませんでした: ${e.message}（AI 中継は動作します。キー保存だけができない状態です）`);
    });
    server.listen(LOCAL_PORT, '127.0.0.1', () => {
        console.log(`[connector] BYOK-Local key endpoint: http://127.0.0.1:${LOCAL_PORT} (allowed origin: ${allowedOrigin || 'unknown'})`);
    });
    return server;
}

// http(s)://host -> ws(s)://host へ変換（認証はヘッダーで送るので URL にトークンは載せない）
function buildWsUrl() {
    const base = BOTYA_URL.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
    return `${base}${CONNECTOR_PATH}`;
}

// ストリーム行から本文デルタを取り出すユニバーサルパーサ。
// - Ollama native /api/chat: NDJSON 行 {message:{content}}（新サーバー）
// - OpenAI 互換 SSE: "data: {choices:[{delta:{content}}]}"（旧サーバー互換）
// どちらの形式でも取り出せるので、サーバー側の移行状態に関わらず沈黙しない。
function extractDeltaText(line) {
    let trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') return null;
    if (trimmed.startsWith('data: ')) trimmed = trimmed.slice(6);
    try {
        const d = JSON.parse(trimmed);
        if (d.message && d.message.content) return d.message.content;
        if (d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content) {
            return d.choices[0].delta.content;
        }
        return null;
    } catch (_) {
        return null; // 分割行などは無視（呼び出し側が持ち越しバッファで再結合する）
    }
}

let ws = null;
let stopping = false;
let keepaliveTimer = null;
let lastCpongAt = 0;

function connect() {
    const wsUrl = buildWsUrl();
    console.log(`[connector] connecting to ${wsUrl} ...`);
    ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${BOTYA_TOKEN}` } });

    ws.on('open', () => {
        console.log(`[connector] connected. relaying to local Ollama at ${OLLAMA_URL}`);
        // アプリレベル keepalive を開始。Cloudflare 経由だと WS 制御フレーム(ping/pong)が
        // 透過せず、サーバーに切られたりハーフオープンに気づけない。データフレームの
        // cping/cpong で ①アイドル切断防止 ②応答途絶を検知して張り直す を実現する。
        lastCpongAt = Date.now();
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = setInterval(() => {
            if (Date.now() - lastCpongAt > DEAD_AFTER_MS) {
                console.warn('[connector] keepalive 応答途絶 — 接続が死んだとみなして張り直します。');
                try { ws.terminate(); } catch (_) {}
                return;
            }
            send({ t: 'cping' });
        }, KEEPALIVE_MS);
    });

    ws.on('message', async (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }

        if (msg.t === 'hello') {
            console.log('[connector] handshake ok');
            return;
        }

        if (msg.t === 'cpong') { lastCpongAt = Date.now(); return; }

        // BYOK-Local: クラウド中継（意味論スキーマ）。Ollama 中継の path/method/body とは
        // kind で明確に区別する（cloud_chat に URL/パスの概念は存在しない）。
        if (msg.t === 'req' && msg.id != null && msg.payload && msg.payload.kind === 'cloud_chat') {
            handleCloudChatRequest(msg);
            return;
        }

        if (msg.t === 'req' && msg.id != null) {
            const { path, method, body } = msg.payload || {};

            // 許可リスト外は実行しない（stream/非stream どちらの応答形でも拒否を返す）。
            if (!isAllowedRequest(method, path)) {
                console.warn(`[connector] blocked non-allowlisted request: ${method || 'POST'} ${path}`);
                if (msg.stream) send({ t: 'err', id: msg.id, error: 'このリクエストは許可されていません' });
                else send({ t: 'res', id: msg.id, ok: false, error: 'このリクエストは許可されていません' });
                return;
            }

            const target = `${OLLAMA_URL}${path}`;
            if (msg.stream) {
                // ストリーミング中継（B-2 ①）: Ollama を stream:true で叩き、delta を逐次 chunk で返す。
                try {
                    const resp = await fetch(target, {
                        method: method || 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: body != null ? JSON.stringify(body) : undefined
                    });
                    if (!resp.ok) {
                        const errText = await resp.text();
                        send({ t: 'err', id: msg.id, status: resp.status, error: `Ollama ${resp.status}: ${errText}` });
                        console.error(`[connector] stream relay ${path} -> ${resp.status}`);
                        return;
                    }
                    // 行の分断は持ち越しバッファ、マルチバイト文字のバイト分断は StringDecoder で復元
                    // （per-chunk toString() は UTF-8 文字の途中でチャンクが割れると文字化けする）。
                    let buffer = '';
                    const utf8Decoder = new StringDecoder('utf8');
                    for await (const part of resp.body) {
                        buffer += utf8Decoder.write(Buffer.from(part));
                        const lines = buffer.split('\n');
                        buffer = lines.pop();
                        for (const line of lines) {
                            const t = extractDeltaText(line);
                            if (t) send({ t: 'chunk', id: msg.id, data: t });
                        }
                    }
                    // 終端フラッシュ: デコーダ残り + 最終行（改行なし終端でも取りこぼさない）
                    buffer += utf8Decoder.end();
                    const tail = extractDeltaText(buffer);
                    if (tail) send({ t: 'chunk', id: msg.id, data: tail });
                    send({ t: 'end', id: msg.id });
                    console.log(`[connector] streamed ${method || 'POST'} ${path} -> done`);
                } catch (e) {
                    send({ t: 'err', id: msg.id, error: `ローカル Ollama へ接続失敗: ${e.message}` });
                    console.error(`[connector] stream relay error for ${path}: ${e.message}`);
                }
                return;
            }
            try {
                const resp = await fetch(target, {
                    method: method || 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body != null ? JSON.stringify(body) : undefined
                });
                const text = await resp.text();
                let parsed;
                try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
                send({ t: 'res', id: msg.id, ok: resp.ok, status: resp.status, data: parsed });
                console.log(`[connector] relayed ${method || 'POST'} ${path} -> ${resp.status}`);
            } catch (e) {
                send({ t: 'res', id: msg.id, ok: false, error: `ローカル Ollama へ接続失敗: ${e.message}` });
                console.error(`[connector] relay error for ${path}: ${e.message}`);
            }
        }
    });

    ws.on('close', (code, reason) => {
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
        const r = reason ? reason.toString() : '';
        if (FATAL_CLOSES[code]) {
            console.error(`[connector] ${FATAL_CLOSES[code]} (code=${code} ${r})`);
            stopping = true;
            process.exit(1);
        }
        console.warn(`[connector] disconnected (code=${code} ${r}).` + (stopping ? '' : ` reconnecting in ${RECONNECT_MS}ms...`));
        if (!stopping) setTimeout(connect, RECONNECT_MS);
    });

    ws.on('error', (e) => {
        console.error(`[connector] ws error: ${e.message}`);
        // close も続けて発火するので再接続はそちらで
    });
}

function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(obj)); } catch (e) { console.error('[connector] send failed:', e.message); }
    }
}

process.on('SIGINT', () => {
    stopping = true;
    console.log('\n[connector] shutting down...');
    if (ws) try { ws.close(1000, 'bye'); } catch (_) {}
    process.exit(0);
});

startLocalKeyServer();
connect();
