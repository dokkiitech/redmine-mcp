/**
 * Redmine REST API ヘルパー(stdio 版 server.py の api() と同等)
 * 認証は Worker シークレット REDMINE_API_KEY。
 */

// トンネル断・origin 停止(sorry-worker は 503 を返す)を停止扱いにする
const DOWN_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

const DOWN_HINT =
	"Redmine に接続できませんでした。サーバー(EC2)は 3時〜12時 JST は停止しています。" +
	"稼働時間帯(12時〜翌3時 JST)か確認してください。";

export async function redmineApi(
	env: Env,
	method: string,
	path: string,
	params?: Record<string, unknown>,
	body?: unknown,
): Promise<string> {
	const base = (env.REDMINE_URL ?? "https://redmine.dokkiitech.dev").replace(/\/+$/, "");
	const url = new URL(base + path);
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
		}
	}

	let res: Response;
	try {
		res = await fetch(url, {
			method,
			headers: {
				"X-Redmine-API-Key": env.REDMINE_API_KEY,
				"Content-Type": "application/json",
				"User-Agent": "redmine-mcp-remote/0.1",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	} catch (e) {
		return JSON.stringify({ error: String(e), hint: DOWN_HINT });
	}

	const textBody = await res.text();
	if (!res.ok) {
		if (DOWN_STATUSES.has(res.status)) {
			return JSON.stringify({ error: `HTTP ${res.status}`, hint: DOWN_HINT });
		}
		return JSON.stringify({ error: `HTTP ${res.status}`, detail: textBody.slice(0, 2000) });
	}
	return textBody.trim() ? textBody : JSON.stringify({ ok: true, status: res.status });
}
