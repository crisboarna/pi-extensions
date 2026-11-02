// What a page says about itself to a search engine or a link preview: one canonical address, the Open Graph and Twitter tags, and the sitemap.
// Pure string functions over the built pages, so one pass in the build gives every page the same treatment and a test can check all of them.

/** Where the site is served. Every canonical address, preview address and sitemap entry starts here. */
export const SITE_URL = "https://crisboarna.github.io/pi-extensions";

/** The size a link preview image must have: the card both Open Graph and Twitter show at full width. */
export const IMAGE_SIZE = { width: 1200, height: 630 } as const;

/** The public address of a built page: `index.html` becomes its folder, so `/pi-switchboard/` and `/pi-switchboard/index.html` are one page. */
export function pageUrl(path: string): string {
	if (path === "index.html") return `${SITE_URL}/`;
	if (path.endsWith("/index.html")) return `${SITE_URL}/${path.slice(0, -"index.html".length)}`;
	return `${SITE_URL}/${path}`;
}

/** The built files that are pages, not the vendored runtime, the assets or the snapshots a live demo loads. */
export function pagePaths(files: string[]): string[] {
	return files.filter((file) => file.endsWith(".html") && !/^(vendor|assets)\//.test(file) && !/(^|\/)try\//.test(file)).sort();
}

const first = (html: string, pattern: RegExp): string | undefined => pattern.exec(html)?.[1];

/**
 * The page with a canonical link and the Open Graph and Twitter tags added before `</head>`, built from the title and description it already has
 * (both are escaped in the page, so they are reused as they are). Without an image the Twitter card is the small summary, never a broken large one.
 * A page that already has a canonical link is returned unchanged, so running this twice adds nothing.
 */
export function withSocialTags(html: string, path: string, image?: string): string {
	if (html.includes('rel="canonical"')) return html;
	const title = first(html, /<title>([^<]*)<\/title>/);
	const description = first(html, /<meta name="description" content="([^"]*)">/);
	if (title === undefined || description === undefined) throw new Error(`${path}: a page needs a title and a description before it gets social tags`);
	const url = pageUrl(path);
	const tags = [
		`<link rel="canonical" href="${url}">`,
		'<meta property="og:type" content="website">',
		'<meta property="og:site_name" content="pi-extensions">',
		`<meta property="og:title" content="${title}">`,
		`<meta property="og:description" content="${description}">`,
		`<meta property="og:url" content="${url}">`,
		`<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
		`<meta name="twitter:title" content="${title}">`,
		`<meta name="twitter:description" content="${description}">`,
	];
	if (image)
		tags.push(
			`<meta property="og:image" content="${image}">`,
			`<meta property="og:image:width" content="${IMAGE_SIZE.width}">`,
			`<meta property="og:image:height" content="${IMAGE_SIZE.height}">`,
			`<meta name="twitter:image" content="${image}">`,
		);
	return html.replace("</head>", `${tags.join("\n")}\n</head>`);
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The sitemap of the given page paths, one address each, in a fixed order so a build is the same every time. */
export function sitemap(paths: string[]): string {
	const urls = paths.map((path) => `  <url><loc>${escapeXml(pageUrl(path))}</loc></url>`).sort();
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
