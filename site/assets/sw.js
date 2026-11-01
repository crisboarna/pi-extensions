// The site's service worker. It does two jobs.
//
// 1. Offline: the pages and the small files they need are cached when the
//    worker installs, and every same-origin page request goes to the network
//    first and falls back to the cache. Videos and the live demo's snapshot
//    are never cached: they are large, and a video needs Range responses.
// 2. Isolation: it adds the headers GitHub Pages cannot send, so the live
//    pages can run a WebContainer (they need a cross-origin isolated page).
//
// build.ts fills in the version and the file list below when it writes the site.
const VERSION = "__VERSION__";
const PRECACHE = ["__PRECACHE__"];
const CACHE = `pi-extensions-${VERSION}`;
const SKIP = /\.(mp4|webm|gz|vtt)$/;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE.map((path) => new URL(path, self.registration.scope))))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) => Promise.all(names.filter((name) => name.startsWith("pi-extensions-") && name !== CACHE).map((name) => caches.delete(name))))
			.then(() => self.clients.claim()),
	);
});

function isolated(response) {
	if (response.status === 0) return response;
	const headers = new Headers(response.headers);
	// require-corp is the one value Chromium, Firefox and Safari all honour (credentialless is not in Safari).
	headers.set("Cross-Origin-Embedder-Policy", "require-corp");
	headers.set("Cross-Origin-Opener-Policy", "same-origin");
	headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function fromNetworkThenCache(request) {
	const cache = await caches.open(CACHE);
	try {
		const response = await fetch(request);
		if (response.ok && response.status === 200) cache.put(request, response.clone());
		return response;
	} catch (error) {
		const cached = await cache.match(request, { ignoreSearch: true });
		if (cached) return cached;
		throw error;
	}
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
	const url = new URL(request.url);
	const local = url.origin === self.location.origin;
	const cacheable = local && request.method === "GET" && !request.headers.has("range") && !SKIP.test(url.pathname);
	event.respondWith(
		(cacheable ? fromNetworkThenCache(request) : fetch(request)).then(isolated).catch((error) => {
			console.error(error);
			return Response.error();
		}),
	);
});
