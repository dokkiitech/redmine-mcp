"""Redmine MCP サーバー(stdio)。

セルフホスト Redmine を Claude から操作する。
認証は env REDMINE_API_KEY(Redmine のマイアカウント → API アクセスキー)。
接続先は env REDMINE_URL で差し替え可能。

登録例:
  claude mcp add --scope user redmine \
    --env REDMINE_API_KEY=<key> \
    -- uvx --from git+https://github.com/dokkiitech/redmine-mcp redmine-mcp
"""

import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from mcp.server.fastmcp import FastMCP

BASE_URL = os.environ.get("REDMINE_URL", "https://redmine.dokkiitech.dev").rstrip("/")
API_KEY = os.environ.get("REDMINE_API_KEY", "")

DOWN_HINT = (
    "Redmine に接続できませんでした。サーバー(EC2)は 3時〜12時 JST は停止しています。"
    "稼働時間帯(12時〜翌3時 JST)か確認してください。"
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



def upload(filename: str, data: bytes) -> str:
    """バイナリを uploads.json に送ってトークンを得る。"""
    url = f"{BASE_URL}/uploads.json?filename={urllib.parse.quote(filename, safe='')}"
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "X-Redmine-API-Key": API_KEY,
            "Content-Type": "application/octet-stream",
            "User-Agent": "redmine-mcp/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        return json.dumps(
            {"error": f"HTTP {e.code}", "detail": e.read().decode(errors="replace")[:2000]},
            ensure_ascii=False,
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
    return api("GET", f"/issues/{issue_id}.json", {"include": "journals,attachments,relations,allowed_statuses"})


@mcp.tool()
def create_issue(
    project_id: str,
    subject: str,
    description: str | None = None,
    tracker_id: int | None = None,
    priority_id: int | None = None,
    assigned_to_id: int | None = None,
    parent_issue_id: int | None = None,
    custom_fields: list[dict] | None = None,
    uploads: list[dict] | None = None,
) -> str:
    """チケットを新規作成する。

    Args:
        project_id: プロジェクトの identifier または数値 ID
        subject: 件名(必須)
        description: 説明(Textile/Markdown は Redmine 設定に従う)
        tracker_id / priority_id / assigned_to_id: 数値 ID(list_metadata で確認)
        parent_issue_id: 親チケット ID(サブタスクにする場合)
        custom_fields: カスタムフィールド(例: [{"id": 2, "value": "32"}])
        uploads: 添付(例: [{"token": "...", "filename": "a.txt"}]。先に upload_attachment)
    """
    issue = {
        "project_id": project_id,
        "subject": subject,
        "description": description,
        "tracker_id": tracker_id,
        "priority_id": priority_id,
        "assigned_to_id": assigned_to_id,
        "parent_issue_id": parent_issue_id,
        "custom_fields": custom_fields,
        "uploads": uploads,
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
    custom_fields: list[dict] | None = None,
    uploads: list[dict] | None = None,
) -> str:
    """チケットを更新する。コメント追加は notes だけ渡せばよい。

    Args:
        issue_id: チケット ID
        notes: 追加するコメント
        status_id: ステータス数値 ID(list_metadata で確認)
        done_ratio: 進捗率(0-100)
        custom_fields: カスタムフィールド(例: [{"id": 2, "value": "32"}])。
            Redmine は不正値を 204 のまま黙って捨てるので、更新後に get_issue で検証すること
        uploads: 添付(例: [{"token": "...", "filename": "a.txt"}]。先に upload_attachment)
    """
    issue = {
        "notes": notes,
        "status_id": status_id,
        "subject": subject,
        "description": description,
        "assigned_to_id": assigned_to_id,
        "priority_id": priority_id,
        "done_ratio": done_ratio,
        "custom_fields": custom_fields,
        "uploads": uploads,
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
    """ID 指定に必要な参照情報(トラッカー / ステータス / 優先度 / ユーザー / 作業分類)をまとめて返す。"""
    return json.dumps(
        {
            "trackers": json.loads(api("GET", "/trackers.json")),
            "statuses": json.loads(api("GET", "/issue_statuses.json")),
            "priorities": json.loads(api("GET", "/enumerations/issue_priorities.json")),
            "users": json.loads(api("GET", "/users.json", {"limit": 100})),
            "time_entry_activities": json.loads(
                api("GET", "/enumerations/time_entry_activities.json")
            ),
        },
        ensure_ascii=False,
    )


@mcp.tool()
def delete_issue(issue_id: int) -> str:
    """チケットを完全削除する(取り消し不可。通常はステータス「却下」等を検討すること)。"""
    return api("DELETE", f"/issues/{issue_id}.json")


@mcp.tool()
def create_project(
    name: str,
    identifier: str,
    description: str | None = None,
    is_public: bool = False,
    parent_id: int | None = None,
    enabled_module_names: list[str] | None = None,
) -> str:
    """プロジェクトを新規作成する。

    Args:
        name: プロジェクト名
        identifier: 識別子(半角英小文字・数字・ハイフン。後から変更不可)
        is_public: 公開プロジェクトにするか(既定 False)
        enabled_module_names: 有効モジュール(例: ["issue_tracking", "time_tracking", "wiki"])
    """
    project = {
        "name": name,
        "identifier": identifier,
        "description": description,
        "is_public": is_public,
        "parent_id": parent_id,
        "enabled_module_names": enabled_module_names,
    }
    project = {k: v for k, v in project.items() if v is not None}
    return api("POST", "/projects.json", body={"project": project})


@mcp.tool()
def update_project(
    project_id: str,
    name: str | None = None,
    description: str | None = None,
    is_public: bool | None = None,
    parent_id: int | None = None,
    enabled_module_names: list[str] | None = None,
) -> str:
    """プロジェクトを更新する(enabled_module_names は丸ごと置き換えになる点に注意)。"""
    project = {
        "name": name,
        "description": description,
        "is_public": is_public,
        "parent_id": parent_id,
        "enabled_module_names": enabled_module_names,
    }
    project = {k: v for k, v in project.items() if v is not None}
    if not project:
        return json.dumps({"error": "更新内容が空です"}, ensure_ascii=False)
    return api("PUT", f"/projects/{project_id}.json", body={"project": project})


@mcp.tool()
def delete_project(project_id: str) -> str:
    """プロジェクトを完全削除する(チケット・Wiki も全て消える。取り消し不可)。"""
    return api("DELETE", f"/projects/{project_id}.json")


@mcp.tool()
def list_wiki_pages(project_id: str) -> str:
    """プロジェクトの Wiki ページ一覧を返す。"""
    return api("GET", f"/projects/{project_id}/wiki/index.json")


@mcp.tool()
def read_wiki_page(project_id: str, title: str) -> str:
    """Wiki ページの本文を返す。"""
    return api("GET", f"/projects/{project_id}/wiki/{urllib.parse.quote(title, safe='')}.json")


@mcp.tool()
def write_wiki_page(project_id: str, title: str, text: str, comments: str | None = None) -> str:
    """Wiki ページを作成または更新する(存在しなければ作成、あれば上書き)。

    Args:
        text: 本文(Textile/Markdown は Redmine 設定に従う)
        comments: 変更コメント
    """
    return api(
        "PUT",
        f"/projects/{project_id}/wiki/{urllib.parse.quote(title, safe='')}.json",
        body={"wiki_page": {"text": text, "comments": comments}},
    )


@mcp.tool()
def delete_wiki_page(project_id: str, title: str) -> str:
    """Wiki ページを削除する(取り消し不可)。"""
    return api("DELETE", f"/projects/{project_id}/wiki/{urllib.parse.quote(title, safe='')}.json")


@mcp.tool()
def create_time_entry(
    hours: float,
    issue_id: int | None = None,
    project_id: str | None = None,
    activity_id: int | None = None,
    spent_on: str | None = None,
    comments: str | None = None,
) -> str:
    """作業時間を記録する(チケットまたはプロジェクトに紐付け)。

    Args:
        hours: 時間(例: 0.5)
        issue_id: チケット ID(project_id とどちらか必須)
        activity_id: 作業分類 ID(list_metadata の time_entry_activities で確認)
        spent_on: 作業日(YYYY-MM-DD、省略時は今日)
    """
    if issue_id is None and project_id is None:
        return json.dumps({"error": "issue_id か project_id のどちらかが必要です"}, ensure_ascii=False)
    time_entry = {
        "hours": hours,
        "issue_id": issue_id,
        "project_id": project_id,
        "activity_id": activity_id,
        "spent_on": spent_on,
        "comments": comments,
    }
    time_entry = {k: v for k, v in time_entry.items() if v is not None}
    return api("POST", "/time_entries.json", body={"time_entry": time_entry})


@mcp.tool()
def list_time_entries(
    issue_id: int | None = None,
    project_id: str | None = None,
    user_id: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit: int = 25,
) -> str:
    """作業時間の一覧を返す(フィルタ可)。

    Args:
        user_id: 数値 ID または "me"
        from_date / to_date: 期間(YYYY-MM-DD)
    """
    return api(
        "GET",
        "/time_entries.json",
        {
            "issue_id": issue_id,
            "project_id": project_id,
            "user_id": user_id,
            "from": from_date,
            "to": to_date,
            "limit": min(limit, 100),
        },
    )


@mcp.tool()
def update_time_entry(
    time_entry_id: int,
    hours: float | None = None,
    activity_id: int | None = None,
    spent_on: str | None = None,
    comments: str | None = None,
) -> str:
    """作業時間の記録を修正する。"""
    time_entry = {
        "hours": hours,
        "activity_id": activity_id,
        "spent_on": spent_on,
        "comments": comments,
    }
    time_entry = {k: v for k, v in time_entry.items() if v is not None}
    if not time_entry:
        return json.dumps({"error": "更新内容が空です"}, ensure_ascii=False)
    return api("PUT", f"/time_entries/{time_entry_id}.json", body={"time_entry": time_entry})


@mcp.tool()
def delete_time_entry(time_entry_id: int) -> str:
    """作業時間の記録を削除する(取り消し不可)。"""
    return api("DELETE", f"/time_entries/{time_entry_id}.json")


# 注: 文書(Documents)モジュールは Redmine コアの REST API 非対応のため提供できない。
#     ファイル共有はプロジェクトの「ファイル」(Files)か Wiki を使うこと。


@mcp.tool()
def upload_attachment(
    filename: str,
    content_text: str | None = None,
    content_base64: str | None = None,
) -> str:
    """ファイルを Redmine にアップロードしてトークンを得る。

    得たトークンは create_issue / update_issue の uploads、または add_project_file で使う
    (未使用トークンは一定期間で失効)。テキストは content_text、バイナリは content_base64。
    """
    if content_text is None and content_base64 is None:
        return json.dumps(
            {"error": "content_text か content_base64 のどちらかが必要です"}, ensure_ascii=False
        )
    if content_text is not None:
        data = content_text.encode()
    else:
        try:
            data = base64.b64decode(content_base64)
        except Exception:
            return json.dumps({"error": "content_base64 のデコードに失敗しました"}, ensure_ascii=False)
    return upload(filename, data)


@mcp.tool()
def download_attachment(attachment_id: int, max_bytes: int = 200_000) -> str:
    """添付ファイルのメタ情報と中身を取得する(テキストはそのまま、バイナリは base64。上限超は本文省略)。"""
    meta_raw = api("GET", f"/attachments/{attachment_id}.json")
    try:
        meta = json.loads(meta_raw)
    except json.JSONDecodeError:
        return meta_raw
    if "attachment" not in meta:
        return meta_raw
    a = meta["attachment"]
    if a.get("filesize", 0) > max_bytes:
        return json.dumps(
            {
                "attachment": a,
                "note": f"サイズが大きい({a['filesize']} bytes > {max_bytes})ため本文は省略。"
                f"ブラウザで {a.get('content_url')} を開くこと",
            },
            ensure_ascii=False,
        )
    req = urllib.request.Request(
        a["content_url"],
        headers={"X-Redmine-API-Key": API_KEY, "User-Agent": "redmine-mcp/0.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        return json.dumps({"attachment": a, "error": f"content 取得に失敗: {e}"}, ensure_ascii=False)
    ct = a.get("content_type") or ""
    if any(t in ct for t in ("text/", "json", "xml", "csv", "javascript", "yaml", "markdown")):
        return json.dumps({"attachment": a, "content": body.decode(errors="replace")}, ensure_ascii=False)
    return json.dumps(
        {"attachment": a, "content_base64": base64.b64encode(body).decode()}, ensure_ascii=False
    )


@mcp.tool()
def list_files(project_id: str) -> str:
    """プロジェクトの「ファイル」(Files モジュール)一覧を返す。"""
    return api("GET", f"/projects/{project_id}/files.json")


@mcp.tool()
def add_project_file(
    project_id: str,
    token: str,
    filename: str | None = None,
    description: str | None = None,
) -> str:
    """プロジェクトの「ファイル」にアップロード済みファイルを登録する。

    先に upload_attachment でトークンを得る。プロジェクトで files モジュールが有効である必要あり。
    文書(Documents)モジュールは API 非対応のためこちらを使う。
    """
    file = {"token": token, "filename": filename, "description": description}
    file = {k: v for k, v in file.items() if v is not None}
    return api("POST", f"/projects/{project_id}/files.json", body={"file": file})


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
