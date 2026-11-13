/**
 * GitHub アカウント → Redmine ユーザーの対応表。
 *
 * シークレット USER_MAP に JSON で登録する(リポジトリが public なので vars には置かない):
 *   {"dokkiitech": "", "alice-gh": "alice", "bob-gh": "bob"}
 *   - キー: GitHub のログイン名(大文字小文字は区別しない)
 *   - 値:   Redmine のログイン名。空文字なら REDMINE_API_KEY の持ち主として動く(Switch-User しない)
 * 表に無い GitHub アカウントは認可しない(403)。
 *
 * USER_MAP 未設定時は従来どおり ALLOWED_LOGIN の 1 人だけを API キーの持ち主として通す。
 */

export type UserMap = Record<string, string>;

export function loadUserMap(env: Env): UserMap {
	const raw = env.USER_MAP?.trim();
	if (!raw) {
		return env.ALLOWED_LOGIN ? { [env.ALLOWED_LOGIN.toLowerCase()]: "" } : {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.error("USER_MAP が JSON として不正です");
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const map: UserMap = {};
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof v === "string") map[k.toLowerCase()] = v.trim();
	}
	return map;
}

/**
 * GitHub ログイン名から Redmine のログイン名を引く。
 * 許可されていなければ null、API キーの持ち主として動くなら ""。
 */
export function resolveRedmineLogin(env: Env, githubLogin: string | undefined): string | null {
	if (!githubLogin) return null;
	const map = loadUserMap(env);
	const v = map[githubLogin.toLowerCase()];
	return v === undefined ? null : v;
}
