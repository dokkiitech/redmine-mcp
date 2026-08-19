"""Redmine MCP サーバー(stdio)。

セルフホスト Redmine を Claude から操作する。
認証は env REDMINE_API_KEY(Redmine のマイアカウント → API アクセスキー)。
接続先は env REDMINE_URL で差し替え可能。

登録例:
  claude mcp add --scope user redmine \
    --env REDMINE_API_KEY=<key> \
    -- uvx --from git+https://github.com/dokkiitech/redmine-mcp redmine-mcp
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from mcp.server.fastmcp import FastMCP

BASE_URL = os.environ.get("REDMINE_URL", "https://redmine.dokkiitech.dev").rstrip("/")
API_KEY = os.environ.get("REDMINE_API_KEY", "")

DOWN_HINT = (
    "Redmine に接続できませんでした。サーバー(EC2)は 0時〜12時 JST は停止しています。"
    "稼働時間帯(12時〜24時 JST)か確認してください。"
)

mcp = FastMCP("redmine")


def api(method: str, path: str, params: dict | None = None, body: dict | None = None) -> str:
    url = f"{BASE_URL}{path}"
    if params:
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        if query:
            url += f"?{query}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "X-Redmine-API-Key": API_KEY,
            "Content-Type": "application/json",
            "User-Agent": "redmine-mcp/0.1",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode()
            return text if text.strip() else json.dumps({"ok": True, "status": r.status})
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:2000]
        return json.dumps(
            {"error": f"HTTP {e.code}", "detail": detail}, ensure_ascii=False
        )
    except (urllib.error.URLError, TimeoutError) as e:
        return json.dumps({"error": str(e), "hint": DOWN_HINT}, ensure_ascii=False)


@mcp.tool()
def list_projects() -> str:
    """Redmine のプロジェクト一覧を返す。"""
    return api("GET", "/projects.json", {"limit": 100})


@mcp.tool()
def list_issues(
    project_id: str | None = None,
    status_id: str = "open",
    assigned_to_id: str | None = None,
    subject: str | None = None,
    limit: int = 25,
) -> str:
    """チケット一覧を返す。

    Args:
        project_id: プロジェクトの identifier または数値 ID(省略で全プロジェクト)
        status_id: "open" / "closed" / "*" / ステータス数値 ID
        assigned_to_id: 担当者の数値 ID("me" も可)
        subject: 件名の部分一致フィルタ
        limit: 最大件数(既定 25、最大 100)
    """
    params = {
        "project_id": project_id,
        "status_id": status_id,
        "assigned_to_id": assigned_to_id,
        "limit": min(limit, 100),
        "sort": "updated_on:desc",
    }
    if subject:
        params["subject"] = f"~{subject}"
    return api("GET", "/issues.json", params)


@mcp.tool()
def get_issue(issue_id: int) -> str:
    """チケットの詳細(説明・コメント履歴・添付一覧込み)を返す。"""
    return api("GET", f"/issues/{issue_id}.json", {"include": "journals,attachments,relations"})


@mcp.tool()
def create_issue(
    project_id: str,
    subject: str,
    description: str | None = None,
    tracker_id: int | None = None,
    priority_id: int | None = None,
    assigned_to_id: int | None = None,
    parent_issue_id: int | None = None,
) -> str:
    """チケットを新規作成する。

    Args:
        project_id: プロジェクトの identifier または数値 ID
        subject: 件名(必須)
        description: 説明(Textile/Markdown は Redmine 設定に従う)
        tracker_id / priority_id / assigned_to_id: 数値 ID(list_metadata で確認)
        parent_issue_id: 親チケット ID(サブタスクにする場合)
    """
    issue = {
        "project_id": project_id,
        "subject": subject,
        "description": description,
        "tracker_id": tracker_id,
        "priority_id": priority_id,
        "assigned_to_id": assigned_to_id,
        "parent_issue_id": parent_issue_id,
    }
    issue = {k: v for k, v in issue.items() if v is not None}
    return api("POST", "/issues.json", body={"issue": issue})


@mcp.tool()
def update_issue(
    issue_id: int,
    notes: str | None = None,
    status_id: int | None = None,
    subject: str | None = None,
    description: str | None = None,
    assigned_to_id: int | None = None,
    priority_id: int | None = None,
    done_ratio: int | None = None,
) -> str:
    """チケットを更新する。コメント追加は notes だけ渡せばよい。

    Args:
        issue_id: チケット ID
        notes: 追加するコメント
        status_id: ステータス数値 ID(list_metadata で確認)
        done_ratio: 進捗率(0-100)
    """
    issue = {
        "notes": notes,
        "status_id": status_id,
        "subject": subject,
        "description": description,
        "assigned_to_id": assigned_to_id,
        "priority_id": priority_id,
        "done_ratio": done_ratio,
    }
    issue = {k: v for k, v in issue.items() if v is not None}
    if not issue:
        return json.dumps({"error": "更新内容が空です"}, ensure_ascii=False)
    return api("PUT", f"/issues/{issue_id}.json", body={"issue": issue})


@mcp.tool()
def search(query: str, limit: int = 25) -> str:
    """Redmine 全体を全文検索する(チケット・Wiki・ニュース等)。"""
    return api("GET", "/search.json", {"q": query, "limit": min(limit, 100)})


@mcp.tool()
def list_metadata() -> str:
    """ID 指定に必要な参照情報(トラッカー / ステータス / 優先度 / ユーザー)をまとめて返す。"""
    return json.dumps(
        {
            "trackers": json.loads(api("GET", "/trackers.json")),
            "statuses": json.loads(api("GET", "/issue_statuses.json")),
            "priorities": json.loads(api("GET", "/enumerations/issue_priorities.json")),
            "users": json.loads(api("GET", "/users.json", {"limit": 100})),
        },
        ensure_ascii=False,
    )


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
