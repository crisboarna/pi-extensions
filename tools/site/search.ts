// The site's search index: one entry per page, with its title and the text of its main content, written to search.json and read by the
// script in assets/site.js. No dependency and no server: the browser downloads the file the first time the search box is used and filters it.

/**
 * The text of a piece of HTML: whatever lies outside its tags, read a character at a time, so no tag
 * shape (`<<script>script>`) can survive a single pass. The text keeps the entities `marked` wrote.
 */
export function textOfHtml(html: string): string {
	let text = "";
	let inTag = false;
	for (const char of html) {
		if (char === "<") inTag = true;
		else if (char === ">") inTag = false;
		else if (!inTag) text += char;
	}
	return text.trim();
}

export interface SearchEntry {
	title: string;
	/** The page's path from the site root, as its links use it. */
	url: string;
	/** The main content's text, whitespace collapsed and cut to `MAX_TEXT`. */
	text: string;
}

/** The most text kept per page: enough to match what a page is about, small enough that the whole index stays a quick download. */
export const MAX_TEXT = 3000;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

const decode = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);

/** The entry for a built page, or undefined for a page with no title. Scripts and styles inside the content never count as text. */
export function searchEntry(path: string, html: string): SearchEntry | undefined {
	const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
	if (title === undefined) return undefined;
	const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
	const content = main.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ");
	const text = decode(textOfHtml(content)).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
	return { title: decode(title), url: path, text };
}

/** The index of the given pages (path and HTML), in path order, as the JSON the browser downloads. */
export function searchIndex(pages: Array<{ path: string; html: string }>): string {
	const entries = pages
		.map((page) => searchEntry(page.path, page.html))
		.filter((entry): entry is SearchEntry => entry !== undefined)
		.sort((a, b) => a.url.localeCompare(b.url));
	return JSON.stringify(entries);
}
