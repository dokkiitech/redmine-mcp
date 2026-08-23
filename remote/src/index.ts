import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import { redmineApi, redmineDownloadAttachment, redmineUpload } from "./redmine";
import type { Props } from "./utils";

// wrangler.jsonc の migrations / durable_objects が MyMCP を参照しているためクラス名は維持
export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "redmine",
		version: "1.0.0",
	});

	async init() {
		// 認可は github-handler(/callback)で ALLOWED_LOGIN のみに絞っているが、二重に防御する
		if (this.props!.login !== this.env.ALLOWED_LOGIN) {
			return;
		}

		const api = (
			method: string,
			path: string,
			params?: Record<string, unknown>,
			body?: unknown,
		) => redmineApi(this.env, method, path, params, body);
		const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

		this.server.tool("list_projects", "Redmine のプロジェクト一覧を返す。", {}, async () =>
			text(await api("GET", "/projects.json", { limit: 100 })),
		);

		this.server.tool(
			"list_issues",
			"チケット一覧を返す(更新日時の降順)。",
			{
				project_id: z
					.string()
					.optional()
					.describe("プロジェクトの identifier または数値 ID(省略で全プロジェクト)"),
				status_id: z
					.string()
					.default("open")
					.describe('"open" / "closed" / "*" / ステータス数値 ID'),
				assigned_to_id: z.string().optional().describe('担当者の数値 ID("me" も可)'),
				subject: z.string().optional().describe("件名の部分一致フィルタ"),
				limit: z.number().int().min(1).max(100).default(25).describe("最大件数"),
			},
			async ({ project_id, status_id, assigned_to_id, subject, limit }) => {
				const params: Record<string, unknown> = {
					project_id,
					status_id,
					assigned_to_id,
					limit: Math.min(limit, 100),
					sort: "updated_on:desc",
				};
				if (subject) params.subject = `~${subject}`;
				return text(await api("GET", "/issues.json", params));
			},
		);

		this.server.tool(
			"get_issue",
			"チケットの詳細(説明・コメント履歴・添付一覧込み)を返す。",
			{ issue_id: z.number().int().describe("チケット ID") },
			async ({ issue_id }) =>
				text(
					await api("GET", `/issues/${issue_id}.json`, {
						include: "journals,attachments,relations,allowed_statuses",
					}),
				),
		);

		this.server.tool(
			"create_issue",
			"チケットを新規作成する。ID は list_metadata で確認できる。",
			{
				project_id: z.string().describe("プロジェクトの identifier または数値 ID"),
				subject: z.string().describe("件名(必須)"),
				description: z.string().optional().describe("説明"),
				tracker_id: z.number().int().optional().describe("トラッカー数値 ID"),
				priority_id: z.number().int().optional().describe("優先度数値 ID"),
				assigned_to_id: z.number().int().optional().describe("担当者の数値 ID"),
				parent_issue_id: z.number().int().optional().describe("親チケット ID(サブタスク化)"),
				custom_fields: z
					.array(z.object({ id: z.number().int(), value: z.string() }))
					.optional()
					.describe('カスタムフィールド(例: [{"id":2,"value":"32"}])'),
				uploads: z
					.array(
						z.object({
							token: z.string().describe("upload_attachment で得たトークン"),
							filename: z.string(),
							content_type: z.string().optional(),
							description: z.string().optional(),
						}),
					)
					.optional()
					.describe("添付ファイル(先に upload_attachment でトークンを得る)"),
			},
			async (args) => {
				const issue = Object.fromEntries(
					Object.entries(args).filter(([, v]) => v !== undefined && v !== null),
				);
				return text(await api("POST", "/issues.json", undefined, { issue }));
			},
		);

		this.server.tool(
			"update_issue",
			"チケットを更新する。コメント追加は notes だけ渡せばよい。",
			{
				issue_id: z.number().int().describe("チケット ID"),
				notes: z.string().optional().describe("追加するコメント"),
				status_id: z.number().int().optional().describe("ステータス数値 ID"),
				subject: z.string().optional(),
				description: z.string().optional(),
				assigned_to_id: z.number().int().optional(),
				priority_id: z.number().int().optional(),
				done_ratio: z.number().int().min(0).max(100).optional().describe("進捗率(0-100)"),
				custom_fields: z
					.array(z.object({ id: z.number().int(), value: z.string() }))
					.optional()
					.describe(
						'カスタムフィールド(例: [{"id":2,"value":"32"}])。Redmine は不正値を 204 のまま黙って捨てるので、更新後に get_issue で反映を検証すること',
					),
				uploads: z
					.array(
						z.object({
							token: z.string().describe("upload_attachment で得たトークン"),
							filename: z.string(),
							content_type: z.string().optional(),
							description: z.string().optional(),
						}),
					)
					.optional()
					.describe("添付ファイル(先に upload_attachment でトークンを得る)"),
			},
			async ({ issue_id, ...rest }) => {
				const issue = Object.fromEntries(
					Object.entries(rest).filter(([, v]) => v !== undefined && v !== null),
				);
				if (Object.keys(issue).length === 0) {
					return text(JSON.stringify({ error: "更新内容が空です" }));
				}
				return text(await api("PUT", `/issues/${issue_id}.json`, undefined, { issue }));
			},
		);

		this.server.tool(
			"search",
			"Redmine 全体を全文検索する(チケット・Wiki・ニュース等)。",
			{
				query: z.string().describe("検索クエリ"),
				limit: z.number().int().min(1).max(100).default(25),
			},
			async ({ query, limit }) =>
				text(await api("GET", "/search.json", { q: query, limit: Math.min(limit, 100) })),
		);

		this.server.tool(
			"list_metadata",
			"ID 指定に必要な参照情報(トラッカー / ステータス / 優先度 / ユーザー / 作業分類)をまとめて返す。",
			{},
			async () => {
				const [trackers, statuses, priorities, users, activities] = await Promise.all([
					api("GET", "/trackers.json"),
					api("GET", "/issue_statuses.json"),
					api("GET", "/enumerations/issue_priorities.json"),
					api("GET", "/users.json", { limit: 100 }),
					api("GET", "/enumerations/time_entry_activities.json"),
				]);
				const parse = (s: string) => {
					try {
						return JSON.parse(s);
					} catch {
						return s;
					}
				};
				return text(
					JSON.stringify({
						trackers: parse(trackers),
						statuses: parse(statuses),
						priorities: parse(priorities),
						users: parse(users),
						time_entry_activities: parse(activities),
					}),
				);
			},
		);

		this.server.tool(
			"delete_issue",
			"チケットを完全削除する(取り消し不可。通常はステータス「却下」等を検討すること)。",
			{ issue_id: z.number().int().describe("チケット ID") },
			async ({ issue_id }) => text(await api("DELETE", `/issues/${issue_id}.json`)),
		);

		// ---------- プロジェクト ----------

		this.server.tool(
			"create_project",
			"プロジェクトを新規作成する。",
			{
				name: z.string().describe("プロジェクト名"),
				identifier: z
					.string()
					.describe("識別子(半角英小文字・数字・ハイフン。後から変更不可)"),
				description: z.string().optional(),
				is_public: z.boolean().default(false).describe("公開プロジェクトにするか(既定 false)"),
				parent_id: z.number().int().optional().describe("親プロジェクトの数値 ID"),
				enabled_module_names: z
					.array(z.string())
					.optional()
					.describe(
						'有効モジュール(例: ["issue_tracking","time_tracking","wiki"]。省略時は Redmine の既定)',
					),
			},
			async (args) => {
				const project = Object.fromEntries(
					Object.entries(args).filter(([, v]) => v !== undefined && v !== null),
				);
				return text(await api("POST", "/projects.json", undefined, { project }));
			},
		);

		this.server.tool(
			"update_project",
			"プロジェクトを更新する(モジュール変更時は enabled_module_names が丸ごと置き換えになる点に注意)。",
			{
				project_id: z.string().describe("プロジェクトの identifier または数値 ID"),
				name: z.string().optional(),
				description: z.string().optional(),
				is_public: z.boolean().optional(),
				parent_id: z.number().int().optional(),
				enabled_module_names: z.array(z.string()).optional(),
			},
			async ({ project_id, ...rest }) => {
				const project = Object.fromEntries(
					Object.entries(rest).filter(([, v]) => v !== undefined && v !== null),
				);
				if (Object.keys(project).length === 0) {
					return text(JSON.stringify({ error: "更新内容が空です" }));
				}
				return text(await api("PUT", `/projects/${project_id}.json`, undefined, { project }));
			},
		);

		this.server.tool(
			"delete_project",
			"プロジェクトを完全削除する(チケット・Wiki も全て消える。取り消し不可)。",
			{ project_id: z.string().describe("プロジェクトの identifier または数値 ID") },
			async ({ project_id }) => text(await api("DELETE", `/projects/${project_id}.json`)),
		);

		// ---------- Wiki ----------

		this.server.tool(
			"list_wiki_pages",
			"プロジェクトの Wiki ページ一覧を返す。",
			{ project_id: z.string().describe("プロジェクトの identifier または数値 ID") },
			async ({ project_id }) => text(await api("GET", `/projects/${project_id}/wiki/index.json`)),
		);

		this.server.tool(
			"read_wiki_page",
			"Wiki ページの本文を返す。",
			{
				project_id: z.string().describe("プロジェクトの identifier または数値 ID"),
				title: z.string().describe("ページタイトル"),
			},
			async ({ project_id, title }) =>
				text(await api("GET", `/projects/${project_id}/wiki/${encodeURIComponent(title)}.json`)),
		);

		this.server.tool(
			"write_wiki_page",
			"Wiki ページを作成または更新する(存在しなければ作成、あれば上書き)。",
			{
				project_id: z.string().describe("プロジェクトの identifier または数値 ID"),
				title: z.string().describe("ページタイトル"),
				text: z.string().describe("本文(Textile/Markdown は Redmine 設定に従う)"),
				comments: z.string().optional().describe("変更コメント"),
			},
			async ({ project_id, title, text: body, comments }) =>
				text(
					await api(
						"PUT",
						`/projects/${project_id}/wiki/${encodeURIComponent(title)}.json`,
						undefined,
						{ wiki_page: { text: body, comments } },
					),
				),
		);

		this.server.tool(
			"delete_wiki_page",
			"Wiki ページを削除する(取り消し不可)。",
			{
				project_id: z.string().describe("プロジェクトの identifier または数値 ID"),
				title: z.string().describe("ページタイトル"),
			},
			async ({ project_id, title }) =>
				text(
					await api("DELETE", `/projects/${project_id}/wiki/${encodeURIComponent(title)}.json`),
				),
		);

		// ---------- 作業時間 ----------

		this.server.tool(
			"create_time_entry",
			"作業時間を記録する(チケットまたはプロジェクトに紐付け)。",
			{
				issue_id: z.number().int().optional().describe("チケット ID(project_id とどちらか必須)"),
				project_id: z.string().optional().describe("プロジェクトの identifier または数値 ID"),
				hours: z.number().positive().describe("時間(例: 0.5)"),
				activity_id: z
					.number()
					.int()
					.optional()
					.describe("作業分類 ID(list_metadata の time_entry_activities で確認)"),
				spent_on: z.string().optional().describe("作業日(YYYY-MM-DD、省略時は今日)"),
				comments: z.string().optional().describe("作業内容メモ"),
			},
			async (args) => {
				if (args.issue_id == null && args.project_id == null) {
					return text(JSON.stringify({ error: "issue_id か project_id のどちらかが必要です" }));
				}
				const time_entry = Object.fromEntries(
					Object.entries(args).filter(([, v]) => v !== undefined && v !== null),
				);
				return text(await api("POST", "/time_entries.json", undefined, { time_entry }));
			},
		);

		this.server.tool(
			"list_time_entries",
			"作業時間の一覧を返す(フィルタ可)。",
			{
				issue_id: z.number().int().optional(),
				project_id: z.string().optional(),
				user_id: z.string().optional().describe('数値 ID または "me"'),
				from: z.string().optional().describe("開始日(YYYY-MM-DD)"),
				to: z.string().optional().describe("終了日(YYYY-MM-DD)"),
				limit: z.number().int().min(1).max(100).default(25),
			},
			async ({ limit, ...rest }) =>
				text(await api("GET", "/time_entries.json", { ...rest, limit: Math.min(limit, 100) })),
		);

		this.server.tool(
			"update_time_entry",
			"作業時間の記録を修正する。",
			{
				time_entry_id: z.number().int().describe("作業時間レコードの ID"),
				hours: z.number().positive().optional(),
				activity_id: z.number().int().optional(),
				spent_on: z.string().optional().describe("作業日(YYYY-MM-DD)"),
				comments: z.string().optional(),
			},
			async ({ time_entry_id, ...rest }) => {
				const time_entry = Object.fromEntries(
					Object.entries(rest).filter(([, v]) => v !== undefined && v !== null),
				);
				if (Object.keys(time_entry).length === 0) {
					return text(JSON.stringify({ error: "更新内容が空です" }));
				}
				return text(
					await api("PUT", `/time_entries/${time_entry_id}.json`, undefined, { time_entry }),
				);
			},
		);

		this.server.tool(
			"delete_time_entry",
			"作業時間の記録を削除する(取り消し不可)。",
			{ time_entry_id: z.number().int().describe("作業時間レコードの ID") },
			async ({ time_entry_id }) => text(await api("DELETE", `/time_entries/${time_entry_id}.json`)),
		);

		// ---------- 添付ファイル / プロジェクトファイル ----------
		// 注: 文書(Documents)モジュールは Redmine コアの REST API 非対応のため提供できない。
		//     ファイル共有はプロジェクトの「ファイル」(Files)か Wiki を使うこと。

		this.server.tool(
			"upload_attachment",
			"ファイルを Redmine にアップロードしてトークンを得る。得たトークンは create_issue / update_issue の uploads、または add_project_file で使う(未使用トークンは一定期間で失効)。テキストは content_text、バイナリは content_base64 で渡す。",
			{
				filename: z.string().describe("ファイル名(例: report.md)"),
				content_text: z.string().optional().describe("テキスト内容(content_base64 とどちらか必須)"),
				content_base64: z.string().optional().describe("base64 エンコードしたバイナリ内容"),
			},
			async ({ filename, content_text, content_base64 }) => {
				if (content_text == null && content_base64 == null) {
					return text(
						JSON.stringify({ error: "content_text か content_base64 のどちらかが必要です" }),
					);
				}
				let data: Uint8Array;
				if (content_text != null) {
					data = new TextEncoder().encode(content_text);
				} else {
					try {
						const bin = atob(content_base64!);
						data = Uint8Array.from(bin, (c) => c.charCodeAt(0));
					} catch {
						return text(JSON.stringify({ error: "content_base64 のデコードに失敗しました" }));
					}
				}
				return text(await redmineUpload(this.env, filename, data));
			},
		);

		this.server.tool(
			"download_attachment",
			"添付ファイルのメタ情報と中身を取得する(テキストはそのまま、バイナリは base64。200KB 超は本文省略)。",
			{ attachment_id: z.number().int().describe("添付ファイル ID") },
			async ({ attachment_id }) =>
				text(await redmineDownloadAttachment(this.env, attachment_id)),
		);

		this.server.tool(
			"list_files",
			"プロジェクトの「ファイル」(Files モジュール)一覧を返す。",
			{ project_id: z.string().describe("プロジェクトの identifier または数値 ID") },
			async ({ project_id }) => text(await api("GET", `/projects/${project_id}/files.json`)),
		);

		this.server.tool(
			"add_project_file",
			"プロジェクトの「ファイル」にアップロード済みファイルを登録する(先に upload_attachment でトークンを得る。プロジェクトで files モジュールが有効である必要あり。文書(Documents)モジュールは API 非対応のためこちらを使う)。",
			{
				project_id: z.string().describe("プロジェクトの identifier または数値 ID"),
				token: z.string().describe("upload_attachment で得たトークン"),
				filename: z.string().optional().describe("表示ファイル名(省略時はアップロード時の名前)"),
				description: z.string().optional(),
			},
			async ({ project_id, token: uploadToken, filename, description }) => {
				const file: Record<string, unknown> = { token: uploadToken, filename, description };
				for (const k of Object.keys(file)) if (file[k] == null) delete file[k];
				return text(await api("POST", `/projects/${project_id}/files.json`, undefined, { file }));
			},
		);
	}
}

export default new OAuthProvider({
	apiHandlers: {
		"/mcp": MyMCP.serve("/mcp") as any,
		"/sse": MyMCP.serveSSE("/sse") as any,
	},
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
