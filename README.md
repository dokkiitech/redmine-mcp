# redmine-mcp

セルフホスト Redmine([redmine.dokkiitech.dev](https://redmine.dokkiitech.dev))を
Claude Code から操作するための MCP サーバー(stdio)です。

## セットアップ

前提: [uv](https://docs.astral.sh/uv/) がインストール済みであること。

### 1. Redmine の API キーを発行する

1. Redmine にログイン
2. 右上「マイアカウント」→ 右サイドバー「APIアクセスキー」→「表示」
3. 表示されたキーを控える

### 2. Claude Code に登録する

```bash
claude mcp add --scope user redmine \
  --env REDMINE_API_KEY=<自分のAPIキー> \
  -- uvx --from git+https://github.com/dokkiitech/redmine-mcp redmine-mcp
```

登録後、Claude Code を再起動すると `redmine` サーバーが接続されます。
確認は `claude mcp get redmine`。

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `REDMINE_API_KEY` | ✔ | Redmine の API アクセスキー(各自発行) |
| `REDMINE_URL` | - | 接続先(既定: `https://redmine.dokkiitech.dev`) |

## 提供ツール

| ツール | 説明 |
| --- | --- |
| `list_projects` | プロジェクト一覧 |
| `list_issues` | チケット一覧(プロジェクト・ステータス・担当者・件名で絞り込み) |
| `get_issue` | チケット詳細(コメント履歴・添付込み) |
| `create_issue` | チケット作成 |
| `update_issue` | チケット更新(コメント追加・ステータス変更・進捗率など) |
| `search` | 全文検索(チケット・Wiki・ニュース等) |
| `list_metadata` | トラッカー / ステータス / 優先度 / ユーザーの ID 一覧 |

## 注意

- Redmine サーバー(EC2)は **0時〜12時 JST は停止**しています。接続エラーが出たら稼働時間帯(12時〜24時 JST)か確認してください
- Redmine の REST API は不正な値(存在しないカスタムフィールド ID など)を**エラーにせず黙って無視**します。更新系操作のあとは `get_issue` で読み返して反映を確認するのが安全です

## 更新の取り込み

`uvx` は git リポジトリをキャッシュします。新しいバージョンを取り込むには:

```bash
uv cache clean redmine-mcp
```

## 開発

```bash
git clone https://github.com/dokkiitech/redmine-mcp
cd redmine-mcp
REDMINE_API_KEY=<key> uv run redmine-mcp  # stdio で起動(Ctrl+C で終了)
```

## License

MIT
