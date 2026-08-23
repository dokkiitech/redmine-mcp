# redmine-mcp remote(Cloudflare Worker)

セルフホスト Redmine(https://redmine.dokkiitech.dev)を **ChatGPT / Claude のコネクタ
(スマホアプリ含む)** から使うためのリモート MCP サーバー。
[cloudflare/ai の remote-mcp-github-oauth デモ](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) がベース。

- エンドポイント: `https://redmine-mcp.sukeryo27.workers.dev/mcp`(Streamable HTTP)/ `/sse`(SSE)
- 認証: OAuth 2.1(workers-oauth-provider)+ 上流 GitHub OAuth。
  **`ALLOWED_LOGIN`(= dokkiitech)以外の GitHub アカウントは 403**
- ツール: stdio 版(`src/redmine_mcp/server.py`)と同じ 7 個
  (list_projects / list_issues / get_issue / create_issue / update_issue / search / list_metadata)
- Redmine 停止時間帯(3:00〜12:00 JST)は稼働時間のヒント付きエラーを返す
- コスト: Workers / KV / Durable Objects すべて無料枠(¥0)

## 初回セットアップ

```sh
cd remote && npm install

# 1. KV(OAuth トークン保存用)を作成し、出力された id を wrangler.jsonc に転記
npx wrangler kv namespace create OAUTH_KV

# 2. GitHub OAuth App(https://github.com/settings/applications/new)
#    Homepage:  https://redmine-mcp.sukeryo27.workers.dev
#    Callback:  https://redmine-mcp.sukeryo27.workers.dev/callback

# 3. シークレット登録
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
npx wrangler secret put REDMINE_API_KEY         # Redmine マイアカウント → API アクセスキー

# 4. デプロイ
npm run deploy
```

必要なトークン権限(API トークンでデプロイする場合): Workers Scripts:Edit / Workers KV Storage:Edit。
`npx wrangler login`(ブラウザ OAuth)でも可。

## コネクタ登録

- **ChatGPT**: 設定 → コネクタ → 開発者モードを有効化 → 新規コネクタ →
  URL に `https://redmine-mcp.sukeryo27.workers.dev/mcp`、認証 OAuth → GitHub ログイン
- **Claude(claude.ai / スマホアプリ)**: 設定 → コネクタ → カスタムコネクタ追加 → 同 URL

## 動作確認

```sh
npx @modelcontextprotocol/inspector@latest
# URL に /mcp を入れ、OAuth フローで GitHub ログイン → tools/list が返れば OK
```
