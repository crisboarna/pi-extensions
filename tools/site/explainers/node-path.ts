// The node:path functions the explainers' modules use (resolve in
// pi-account-guard's check; resolve, join, relative, isAbsolute, dirname and
// sep in pi-context-refs' core), for the browser: pages map "node:path" here
// with an import map. POSIX paths only.

/** The path separator. */
export const sep = "/";

/** Joins and normalizes POSIX path segments; the last absolute segment starts the path. */
export function resolve(...segments: string[]): string {
	const parts: string[] = [];
	for (const segment of segments) {
		if (segment.startsWith("/")) parts.length = 0;
		for (const part of segment.split("/")) {
			if (part === "" || part === ".") continue;
			if (part === "..") parts.pop();
			else parts.push(part);
		}
	}
	return `/${parts.join("/")}`;
}

/** Whether the path starts at the root. */
export function isAbsolute(path: string): boolean {
	return path.startsWith("/");
}

/** Joins segments and normalizes the result; the path stays relative when it started relative. */
export function join(...segments: string[]): string {
	const joined = segments.filter((segment) => segment !== "").join("/");
	if (joined === "") return ".";
	const parts: string[] = [];
	for (const part of joined.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
		else if (part !== ".." || !isAbsolute(joined)) parts.push(part);
	}
	const body = parts.join("/");
	if (isAbsolute(joined)) return `/${body}`;
	return body === "" ? "." : body;
}

/** The path of `to` as seen from `from`; both are resolved against the root first. */
export function relative(from: string, to: string): string {
	const start = resolve(from).split("/").filter(Boolean);
	const end = resolve(to).split("/").filter(Boolean);
	let shared = 0;
	while (shared < start.length && shared < end.length && start[shared] === end[shared]) shared += 1;
	return [...start.slice(shared).map(() => ".."), ...end.slice(shared)].join("/");
}

/** The directory part of a path. */
export function dirname(path: string): string {
	const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
	const slash = trimmed.lastIndexOf("/");
	if (slash < 0) return ".";
	return slash === 0 ? "/" : trimmed.slice(0, slash);
}
