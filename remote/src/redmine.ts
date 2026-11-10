/**
 * Redmine REST API ヘルパー(stdio 版 server.py の api() と同等)
 * 認証は Worker シークレット REDMINE_API_KEY。
 */

// Redmine の EC2 はスポットインスタンスで24時間稼働(定時停止なし、2026-11-08〜)。
// 止まっているときは AWS のスポット中断。Cloudflare の sorry-worker が 503 + X-Down-Reason と
// JSON(reason / message / retry_after_seconds)を返すので、それをそのまま停止理由として返す。
// トンネル断・origin 停止を停止扱いにする
const DOWN_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

const DOWN_HINTS: Record<string, string> = {
	"spot-interruption":
		"Redmine は AWS スポットインスタンスの中断により一時停止しています。" +
		"Redmine は24時間稼働で定時停止(時間帯による停止)はありません。" +
		"空き容量が戻ると自動で再開するので、時間をおいて再試行してください。",
	"scheduled-stop": "Redmine は稼働時間外のため定時停止中です。稼働時間になると自動で再開します。",
	unexpected: "Redmine は稼働しているはずですが応答がありません。障害の可能性があります。",
};

const DOWN_HINT =
	"Redmine に接続できませんでした。Redmine は AWS スポットインスタンスで24時間稼働しており、" +
	"定時停止(時間帯による停止)はありません。スポット中断による一時停止か、ネットワーク・障害の可能性があります。" +
	"スポット中断なら空き容量が戻ると自動で再開するので、時間をおいて再試行してください。";

/** 停止時のエラー応答。sorry-worker の停止理由があればそれを優先する */
function downError(error: string, headers?: Headers, body = ""): string {
	let info: Record<string, any> = {};
	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed === "object" && parsed.error === "service_unavailable") info = parsed;
	} catch {
		// HTML(旧 sorry ページ)や空ボディはヘッダーだけで判断
	}
	const reason: string | undefined = info.reason ?? headers?.get("x-down-reason") ?? undefined;
	const result: Record<string, unknown> = {
		error,
		stop_reason: reason ?? "unknown",
		scheduled_stop: reason === "scheduled-stop",
		hint: info.message || (reason && DOWN_HINTS[reason]) || DOWN_HINT,
	};
	const retry = Number(info.retry_after_seconds ?? headers?.get("retry-after") ?? NaN);
	if (Number.isInteger(retry) && retry > 0) result.retry_after_seconds = retry;
	return JSON.stringify(result);
}

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
		return downError(String(e));
	}

	const textBody = await res.text();
	if (!res.ok) {
		if (DOWN_STATUSES.has(res.status)) {
			return downError(`HTTP ${res.status}`, res.headers, textBody);
		}
		return JSON.stringify({ error: `HTTP ${res.status}`, detail: textBody.slice(0, 2000) });
	}
	return textBody.trim() ? textBody : JSON.stringify({ ok: true, status: res.status });
}

/** バイナリを uploads.json に送ってトークンを得る */
export async function redmineUpload(env: Env, filename: string, data: Uint8Array): Promise<string> {
	const base = (env.REDMINE_URL ?? "https://redmine.dokkiitech.dev").replace(/\/+$/, "");
	const url = `${base}/uploads.json?filename=${encodeURIComponent(filename)}`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"X-Redmine-API-Key": env.REDMINE_API_KEY,
				"Content-Type": "application/octet-stream",
				"User-Agent": "redmine-mcp-remote/0.1",
			},
			body: data as unknown as BodyInit,
		});
	} catch (e) {
		return downError(String(e));
	}
	const textBody = await res.text();
	if (!res.ok) {
		if (DOWN_STATUSES.has(res.status)) return downError(`HTTP ${res.status}`, res.headers, textBody);
		return JSON.stringify({ error: `HTTP ${res.status}`, detail: textBody.slice(0, 2000) });
	}
	return textBody;
}

const TEXTUAL = /^text\/|json|xml|csv|javascript|yaml|markdown/i;

/** 添付の中身を取得(テキストのみ。サイズ上限つき) */
export async function redmineDownloadAttachment(
	env: Env,
	attachmentId: number,
	maxBytes = 200_000,
): Promise<string> {
	const meta = await redmineApi(env, "GET", `/attachments/${attachmentId}.json`);
	let parsed: any;
	try {
		parsed = JSON.parse(meta);
	} catch {
		return meta;
	}
	if (!parsed.attachment) return meta;
	const a = parsed.attachment;
	if (a.filesize > maxBytes) {
		return JSON.stringify({
			attachment: a,
			note: `サイズが大きい(${a.filesize} bytes > ${maxBytes})ため本文は省略。ブラウザで ${a.content_url} を開くこと`,
		});
	}
	const res = await fetch(a.content_url, {
		headers: { "X-Redmine-API-Key": env.REDMINE_API_KEY, "User-Agent": "redmine-mcp-remote/0.1" },
	});
	if (!res.ok) {
		return JSON.stringify({ attachment: a, error: `content 取得に失敗: HTTP ${res.status}` });
	}
	if (TEXTUAL.test(a.content_type ?? "")) {
		return JSON.stringify({ attachment: a, content: await res.text() });
	}
	const buf = new Uint8Array(await res.arrayBuffer());
	let bin = "";
	for (const b of buf) bin += String.fromCharCode(b);
	return JSON.stringify({ attachment: a, content_base64: btoa(bin) });
}
