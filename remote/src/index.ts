import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GitHubHandler } from "./github-handler";
import { redmineApi } from "./redmine";
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
						include: "journals,attachments,relations",
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
			"ID 指定に必要な参照情報(トラッカー / ステータス / 優先度 / ユーザー)をまとめて返す。",
			{},
			async () => {
				const [trackers, statuses, priorities, users] = await Promise.all([
					api("GET", "/trackers.json"),
					api("GET", "/issue_statuses.json"),
					api("GET", "/enumerations/issue_priorities.json"),
					api("GET", "/users.json", { limit: 100 }),
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
					}),
				);
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
