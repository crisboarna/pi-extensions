// The node:path function the explainers' modules use (resolve, in
// pi-account-guard's check), for the browser: pages map "node:path" here
// with an import map. POSIX paths only.

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
