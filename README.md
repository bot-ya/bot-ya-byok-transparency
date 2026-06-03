# bot-ya BYOK Transparency

このリポジトリは、ノーコード AI チャットボット作成プラットフォーム [bot-ya（bot屋）](https://bot-ya.app)の **BYOK（Bring Your Own Key）機能** に関わるコードを抜粋したものです。

ユーザーから預かった API キーが、bot-ya 内部でどう扱われているかを、誰でも読んで確認できる状態にするためのリポジトリです。

|  |  |
|---|---|
| **最終同期日** | 2026-05-16 |
| **同期元 commit** | `b7caf63be92c1f2db7d8c8469dbdc3e4f01b1f11` |
| **ステータス** | Read-only mirror |
| **ライセンス** | [MIT](./LICENSE) |

---

## なぜ BYOK だけ公開？

BYOK は bot-ya がユーザーの API キーを預かる機能です。「他人の鍵を預かる」のは、bot-ya がユーザーに対して最も信頼を問われる部分です。

ここのコードを公開することで、

- キーがどのように保存・復号されるか
- 復号された値がどこへ送信されるか
- ログ・エラー応答に混入する経路がないか

を、誰でも読んで確認できます。bot-ya が公の場で表明してきた「クラウド API を中継しない、中間マージンを取らない」というスタンスを、コードレベルで確認できる状態にするのが目的です。

bot-ya のプロダクト本体は別の関心事として事業のために保護しています。「BYOK だけ公開」は選択的透明性ではなく、**信頼が問われる場所は開示する / 事業として守る範囲は守る** という一貫した区別の表れです。

---

## このコードは動きません

これは **読んで監査するための reference mirror** です。`npm install` しても動かないように、周辺の足場は意図的に省いてあります:

- 認証ミドルウェア（`src/middleware/auth.js`）
- データベース接続 / マイグレーション（`src/db/db.js`、`src/db/schema.sql`）
- プロバイダー API アダプター実装（`src/utils/ai.js`）
- メーラー、エラーハンドラ、レートリミッター
- `package.json`、ビルド設定

`src/utils/` の 2 ファイル（`crypto.js` / `byokQuota.js`）は本体からそのままコピーしてあります。`src/routes/` の 3 ファイル（`admin-byok.js` / `chat-byok.js` / `line-byok.js`）は、より大きなハンドラから BYOK 経路だけを手動で抜き出した抜粋です。各ファイル冒頭のコメントに「何を残して何を省いたか」を記してあります。

ファイルを読み、データの流れを追ってください。動かす必要はありません。

---

## ファイルマップ

| ファイル | 役割 |
|---|---|
| `src/utils/crypto.js` | API キー保存用の AES-256-CBC encrypt / decrypt |
| `src/utils/byokQuota.js` | JST 区切りの日次 / 月次トークン使用量追跡、上限到達時のメール通知トリガー |
| `src/routes/admin-byok.js` | 管理画面 API: activate / deactivate / status / usage / limits / reset-counter |
| `src/routes/chat-byok.js` | `/api/chat` の BYOK 経路抜粋（quota チェック → decrypt → プロバイダー呼び出し → 使用量加算） |
| `src/routes/line-byok.js` | LINE webhook の BYOK 経路抜粋（web チャットと同じ財布を共有） |
| `docs/schema-byok.md` | `bots` テーブルの BYOK 関連カラム定義、ライフサイクル、暗号化方式 |
| `.env.example` | 本リポ範囲で関係する環境変数（`ENCRYPTION_KEY` のみ） |

---

## セキュリティに関する設計判断

監査する人の便宜のため、明示しておくべき判断が 2 つあります。

### 1. 復号失敗時は throw する

`crypto.js` は復号できなかった暗号文を例外で返します。「失敗時に暗号文をそのまま返す」「空文字を返す」「best-effort で何かを返す」といった fallback パスは存在しません。

fail-secure 原則: 鍵がきれいに復号できないなら、**止める**。推測しない。

副作用として、`ENCRYPTION_KEY` を変更した場合や DB の暗号文が壊れた場合、API リクエストは HTTP 500 で失敗します。これは意図された挙動です — 黙って壊れた値を下流に流すよりも、問題を表面化させるほうが望ましい。

### 2. プロバイダーのエラー応答は加工せず転送する

OpenAI / Anthropic / Google / xAI の API が non-200 を返した場合、`chat.js`（および `chat-byok.js`）はプロバイダーの応答ペイロードをそのままクライアントへ転送します。これは **プロバイダーがエラー応答に呼び出し元の API キー値を含めない** という前提に依存しています。本リポジトリ作成時点では、サポート対象の 4 プロバイダーすべてがこの前提を満たしています。

これは見落としではなく明示的な設計判断です。もしどこかのプロバイダーがエラー応答にキーを反射するケースを発見した場合は、それは本物のバグとして報告してください（下記 "セキュリティ報告" 参照）。

---

## 同期ポリシー

このミラーは bot-ya 本体側で BYOK コードが変更されたときに、手動で同期されます。冒頭の "同期元 commit" が同期時点での本体のコミットハッシュです。

- **Pull Request は受け付けません** — このリポジトリは read-only mirror であり、コミュニティプロジェクトではありません
- 本リポに対する Issue は、本体への報告経路として案内する形で対応します

---

## セキュリティ報告

ここに掲載されたコードに脆弱性を発見した場合は、公開 Issue を立てる前に `info@bot-ya.app` までご連絡ください。

---

## ライセンス

[MIT](./LICENSE)

---

## 関連

- bot-ya 本体: https://bot-ya.app
- bot-ya の AI 透明性スタンス: https://bot-ya.app/listing.html#ai-transparency
