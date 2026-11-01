// The node:url function pi-context-refs' core imports, for the browser. It
// sits on the Recent refs path, which the explainer does not use; a file: URL
// is decoded the way Node does it for POSIX paths.

/** The path a `file:` URL names. */
export function fileURLToPath(url: string | URL): string {
	const parsed = typeof url === "string" ? new URL(url) : url;
	if (parsed.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
	return decodeURIComponent(parsed.pathname);
}
