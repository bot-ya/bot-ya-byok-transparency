/**
 * BYOK-Local transparency excerpt of src/utils/connectorHub.js
 *
 * connectorHub.js is the server-side hub for the reverse-WebSocket connector
 * (the "接続アプリ" running on the bot owner's machine). This excerpt shows the
 * BYOK-Local (fully local key) relay functions only:
 *
 *   - What the server SENDS to the connector for a cloud chat: a fixed semantic
 *     schema {kind:'cloud_chat', provider, model, messages, systemPrompt, options}.
 *     There is no field for a URL, path, headers or key — the server cannot express
 *     "send this somewhere else" even if fully compromised. The connector builds the
 *     entire HTTP request from its own hardcoded provider table and its locally
 *     stored key (see connector/bot-ya-connector.js — the exact source of the
 *     distributed connector app).
 *   - What the server RECEIVES back: text chunks, and a final usage object
 *     (meta.raw) used only for the owner's quota tracking. The key never comes back.
 *
 * Omitted from the original connectorHub.js:
 *   - WS server bootstrap / device-token authentication / keepalive & liveness
 *   - the Ollama (BYOM) relay functions (no cloud key involved)
 *
 * Read-only — this file does NOT run as-is. See README.md.
 */

// オーナーの接続アプリが未接続のとき、チャット/LINE に返す文言。
// platform モデルへ勝手にフォールバックしない（オーナーが選んでいない AI へ繋がない）。
const BYOK_LOCAL_OFFLINE_MESSAGE = 'このボットは現在オフラインです。AI への接続を担うオーナーの接続アプリが起動していない可能性があります。しばらくしてから、もう一度お試しください。';

// ==========================================================================
// BYOK-Local（完全ローカル鍵）: クラウドチャットのコネクタ中継
// --------------------------------------------------------------------------
// キーはオーナー機のコネクタにのみ保存されている。サーバーは意味論スキーマ
// {kind:'cloud_chat', provider, model, messages, systemPrompt, options} だけを送り、
// URL・ヘッダー・パスは一切送らない（コネクタ側の固定プロバイダー表が組み立てる＝
// 汎用プロキシ禁止。サーバーが侵害されてもキー窃取・任意URL送信は構造的に不可）。
// ==========================================================================

function buildCloudChatPayload(provider, model, messages, systemPrompt, options) {
    return { kind: 'cloud_chat', provider, model, messages, systemPrompt, options: options || {} };
}

// 非ストリーム版（LINE 等）。返却形は utils/ai.js の call 系と同じ {status, data:{text, raw, error}}。
// raw にはコネクタが集めた usage（extractTokenUsage が読む形状）が入る。
// forwardToConnector は「接続中の WS へ payload を送り、res フレームを待つ」共通機構（本体参照）。
async function callCloudViaConnector(ownerId, provider, model, messages, systemPrompt, options) {
    const res = await forwardToConnector(
        ownerId,
        buildCloudChatPayload(provider, model, messages, systemPrompt, options),
        FIRST_RESPONSE_TIMEOUT_MS
    );
    if (!res.ok) {
        return { status: 502, data: { text: null, error: { message: `BYOK-Local connector: ${res.error}` }, raw: null } };
    }
    const data = res.data || {};
    return { status: 200, data: { text: data.text || null, raw: data.raw || null, error: null } };
}

// ストリーム版。返却形は utils/ai.js のクラウドストリームアダプターと同じ
// { status: 200, stream: AsyncGenerator<string>, meta: { raw } }（chat.js が対称に扱える）。
// meta.raw はストリーム完走後に usage 入りの最終 raw が入る（quota 集計用）。
// relayStreamViaConnector は「chunk フレームのテキスト片を yield し、end フレームの
// meta.raw を meta へ書き込む」共通機構（本体参照。BYOM の Ollama 中継と同じ配管）。
function streamCloudViaConnector(ownerId, provider, model, messages, systemPrompt, options) {
    const meta = { raw: null };
    const stream = relayStreamViaConnector(
        ownerId,
        buildCloudChatPayload(provider, model, messages, systemPrompt, options),
        meta
    );
    return { status: 200, stream, meta };
}

module.exports = {
    callCloudViaConnector,
    streamCloudViaConnector,
    BYOK_LOCAL_OFFLINE_MESSAGE
};
