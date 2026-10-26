const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalizes a remote fetch URL to `host/path` (DESIGN.md section 5): the scheme, the user and a `.git`
 * suffix are removed, the `:` after the host becomes `/`, and the result is percent-decoded.
 * The host is kept as written.
 */
export function normalizeRemoteUrl(url: string): string {
	let rest = url.trim();
	const hasScheme = SCHEME.test(rest);
	rest = rest.replace(SCHEME, "");
	const slash = rest.indexOf("/");
	const authority = slash < 0 ? rest : rest.slice(0, slash);
	const tail = slash < 0 ? "" : rest.slice(slash);
	const withoutUser = authority.slice(authority.lastIndexOf("@") + 1);
	// An scp-like URL (`user@host:path`) has no scheme; the first `:` separates host and path.
	const host = hasScheme || !withoutUser.includes(":") ? withoutUser : withoutUser.replace(":", "/");
	const path = `${host.replaceAll(":", "/")}${tail}`.replace(/\/{2,}/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
	return percentDecode(path);
}

function percentDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}
