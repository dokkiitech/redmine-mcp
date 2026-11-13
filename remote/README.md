# redmine-mcp remote(Cloudflare Worker)

セルフホスト Redmine(https://redmine.dokkiitech.dev)を **ChatGPT / Claude のコネクタ
(スマホアプリ含む)** から使うためのリモート MCP サーバー。
[cloudflare/ai の remote-mcp-github-oauth デモ](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) がベース。

- エンドポイント: `https://redmine-mcp.sukeryo27.workers.dev/mcp`(Streamable HTTP)/ `/sse`(SSE)
- 認証: OAuth 2.1(workers-oauth-provider)+ 上流 GitHub OAuth。
  **シークレット `USER_MAP` に載っている GitHub アカウントだけ通し、それ以外は 403**
- **ユーザー分離**: 管理者の `REDMINE_API_KEY` に `X-Redmine-Switch-User` を付け、
  接続した本人の Redmine ユーザーとして操作する(権限・作成者・履歴・`me` が本人になる)
- ツール: stdio 版(`src/redmine_mcp/server.py`)と同じ 24 個
  - チケット: list_issues / get_issue / create_issue / update_issue(custom_fields・uploads 対応)/ delete_issue / search
  - プロジェクト: list_projects / get_project / create_project / update_project / delete_project
  - Wiki: list_wiki_pages / read_wiki_page / write_wiki_page / delete_wiki_page
  - 作業時間: create_time_entry / list_time_entries / update_time_entry / delete_time_entry
  - 添付・ファイル: upload_attachment / download_attachment / list_files / add_project_file
  - 参照: list_metadata(作業分類込み)
- **文書(Documents)モジュールは Redmine コアの REST API 非対応**のため提供不可。
  ファイル共有はプロジェクトの「ファイル」(Files モジュール)か Wiki を使う
- Redmine 停止中(スポット中断など)は停止理由付きのエラー(`stop_reason` / `scheduled_stop` / `hint` / `retry_after_seconds`)を返す。定時停止はない(24時間稼働)
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
npx wrangler secret put REDMINE_API_KEY         # 管理者ユーザーの API アクセスキー
npx wrangler secret put USER_MAP                # 下記「メンバーの追加・削除」

# 4. デプロイ
npm run deploy
```

必要なトークン権限(API トークンでデプロイする場合): Workers Scripts:Edit / Workers KV Storage:Edit。
`npx wrangler login`(ブラウザ OAuth)でも可。

## メンバーの追加・削除(USER_MAP)

GitHub ログイン名 → Redmine ログイン名の JSON をシークレットに登録する
(リポジトリが public なので vars ではなくシークレット)。値が空文字の人は API キーの持ち主として動く。

```sh
echo '{"dokkiitech":"","alice-gh":"alice","bob-gh":"bob"}' | npx wrangler secret put USER_MAP
```

- シークレット更新だけで反映される(再デプロイ不要)。表から消した人は次のセッションから使えない
- 前提: `REDMINE_API_KEY` は **管理者ユーザーのキー**、各メンバーの Redmine アカウントが有効(ロックされていない)こと。
  満たさないと Redmine が 412 を返し、ツールは理由付きのエラーを返す
- `USER_MAP` 未設定時は従来どおり `ALLOWED_LOGIN` の 1 人だけ通す
- 一般ユーザーは `list_metadata` の users(`/users.json`)が管理者専用のため取得できない

## コネクタ登録

- **ChatGPT**: 設定 → コネクタ → 開発者モードを有効化 → 新規コネクタ →
  URL に `https://redmine-mcp.sukeryo27.workers.dev/mcp`、認証 OAuth → GitHub ログイン
- **Claude(claude.ai / スマホアプリ)**: 設定 → コネクタ → カスタムコネクタ追加 → 同 URL

## 動作確認

```sh
npx @modelcontextprotocol/inspector@latest
# URL に /mcp を入れ、OAuth フローで GitHub ログイン → tools/list が返れば OK
```
