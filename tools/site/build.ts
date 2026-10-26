// Builds the family site: a landing page, one page per package rendered from
// its README, its docs and its design notes, the media those pages show, the
// Markdown sources and llms.txt for agents. It ends with a link check: every
// relative link, image and anchor in the output must resolve, or the build
// fails.
//
//   node tools/site/build.ts [out]      (default: site/dist)
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Marked, type Tokens } from "marked";
import { ROOT } from "../../scripts/lib/repo.ts";
import { checkSiteLinks } from "./links.ts";

const REPO_URL = "https://github.com/crisboarna/pi-extensions";
const RAW_PREFIX = "https://raw.githubusercontent.com/crisboarna/pi-extensions/main/";
const BLOB_PREFIX = `${REPO_URL}/blob/main/`;
const SITE = join(ROOT, "site");
/** Each package's one accent, as on its mark; the rest of the palette is the family's. */
const ACCENTS: Record<string, string> = { "pi-switchboard": "#c8452f", "pi-account-guard": "#3f8f8c" };

export interface SitePage {
	/** Repository-relative path of the Markdown source. */
	source: string;
	/** Output path relative to the site root. */
	out: string;
	title: string;
	group: "Overview" | "Docs" | "Design";
}

export interface SitePackage {
	folder: string;
	name: string;
	description: string;
	/** The first sentence of the README's lede, links reduced to their text. */
	pitch: string;
	accent: string;
	pages: SitePage[];
	/** A page with the package's static explainer, when it has one (site/explainers/<folder>.html). */
	explainer: boolean;
	/** A live try-it page, when its page (site/try/<folder>.html) and its snapshot (site/.snapshots) exist. */
	live: boolean;
}

const titleOf = (markdown: string, fallback: string) => /^# (.+)$/m.exec(markdown)?.[1]?.replace(/`/g, "") ?? fallback;

/** The first prose paragraph of a README (not a heading, badge, image or HTML), first sentence only. */
function pitchOf(readme: string, fallback: string): string {
	const paragraph = readme.split(/\n\s*\n/).find((block) => /^[A-Z]/.test(block.trim()));
	const text = paragraph
		?.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	return text?.match(/^.*?\.(?=\s|$)/)?.[0] ?? fallback;
}

/** The packages and the pages each one gets: README, docs/*.md, docs/adr/*.md, DESIGN.md and GLOSSARY.md. Plans stay in the repository. */
export function sitePackages(root = ROOT): SitePackage[] {
	return readdirSync(join(root, "packages"))
		.filter((folder) => existsSync(join(root, "packages", folder, "package.json")))
		.sort()
		.map((folder) => {
			const base = join(root, "packages", folder);
			const manifest = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { name: string; description: string };
			const page = (file: string, out: string, group: SitePage["group"]): SitePage => ({
				source: `packages/${folder}/${file}`,
				out: `${folder}/${out}`,
				title: file === "README.md" ? "Overview" : file === "GLOSSARY.md" ? "Glossary" : titleOf(readFileSync(join(base, file), "utf8"), file),
				group,
			});
			const markdownIn = (dir: string) =>
				existsSync(join(base, dir))
					? readdirSync(join(base, dir))
							.filter((file) => file.endsWith(".md"))
							.sort()
					: [];
			const pages = [
				page("README.md", "index.html", "Overview"),
				...markdownIn("docs").map((file) => page(`docs/${file}`, `docs/${file.replace(/\.md$/, ".html")}`, "Docs")),
				...["DESIGN.md", "GLOSSARY.md"]
					.filter((file) => existsSync(join(base, file)))
					.map((file) => page(file, file.replace(/\.md$/, ".html"), "Design")),
				...markdownIn("docs/adr").map((file) => page(`docs/adr/${file}`, `docs/adr/${file.replace(/\.md$/, ".html")}`, "Design")),
			];
			return {
				folder,
				name: manifest.name,
				description: manifest.description,
				pitch: pitchOf(readFileSync(join(base, "README.md"), "utf8"), manifest.description),
				accent: ACCENTS[folder] ?? "var(--brass)",
				pages,
				explainer: existsSync(join(root, "site", "explainers", `${folder}.html`)),
				live: existsSync(join(root, "site", "try", `${folder}.html`)) && existsSync(join(root, "site", ".snapshots", `${folder}.snapshot.gz`)),
			};
		});
}

/** GitHub's heading ids: lowercase, punctuation dropped, spaces to hyphens, repeats numbered. */
function slugger() {
	const seen = new Map<string, number>();
	return (text: string) => {
		const base = text
			.replace(/<[^>]+>/g, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.replace(/\s/g, "-");
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}-${count}`;
	};
}

function renderMarkdown(markdown: string): string {
	const slug = slugger();
	const marked = new Marked({
		gfm: true,
		renderer: {
			heading(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Heading) {
				const inner = this.parser.parseInline(token.tokens);
				return `<h${token.depth} id="${slug(token.text.replace(/`/g, ""))}">${inner}</h${token.depth}>\n`;
			},
		},
	});
	// Badges point at npm and GitHub; the site says the same in its own words.
	const withoutBadges = markdown.replace(/^\[!\[[^\]]*\]\(https:\/\/img\.shields\.io[^\n]*\n/m, "");
	// A poster that links to its video becomes the video itself, with the narration's subtitles when they exist.
	const withVideos = withoutBadges.replace(/\[!\[([^\]]*)\]\(([^)\s]+\.png)\)\]\(([^)\s]+\.mp4)\)/g, (_all, alt: string, poster: string, video: string) => {
		const src = video.replace("/blob/main/", "/raw/main/");
		const subtitles = src.replace(/\.mp4$/, ".vtt");
		const local = subtitles.startsWith(`${REPO_URL}/raw/main/`) ? subtitles.slice(`${REPO_URL}/raw/main/`.length) : undefined;
		const track = local && existsSync(join(ROOT, local)) ? `<track kind="captions" srclang="en" label="Narration" src="${subtitles}" default>` : "";
		return `<video controls preload="none" poster="${poster}" src="${src}" aria-label="${alt.replace(/"/g, "&quot;")}">${track}</video>`;
	});
	return marked.parse(withVideos, { async: false });
}

/** Rewrites every link of a page: media to local copies, Markdown to the generated pages, other repository files to GitHub. */
function rewriteLinks(html: string, page: SitePage, pages: Map<string, string>, copies: Set<string>): string {
	const sourceDir = posix.dirname(page.source);
	const fromOut = posix.dirname(page.out);
	const toOut = (out: string) => posix.relative(fromOut, out) || posix.basename(out);
	const rewrite = (target: string): string => {
		for (const prefix of [RAW_PREFIX, `${REPO_URL}/raw/main/`, BLOB_PREFIX]) {
			if (target.startsWith(prefix) && /\/media\/[^/]+$/.test(target) && existsSync(join(ROOT, target.slice(prefix.length)))) {
				const source = target.slice(prefix.length);
				copies.add(source);
				return toOut(source.replace(/^packages\//, ""));
			}
		}
		if (/^([a-z]+:|#|\/\/)/.test(target)) return target;
		const [path = "", anchor] = target.split("#");
		const source = posix.normalize(posix.join(sourceDir, decodeURIComponent(path)));
		const generated = pages.get(source);
		if (generated) return `${toOut(generated)}${anchor ? `#${anchor}` : ""}`;
		if (/^packages\/[^/]+\/media\/[^/]+$/.test(source) && existsSync(join(ROOT, source))) {
			copies.add(source);
			return toOut(source.replace(/^packages\//, ""));
		}
		if (!existsSync(join(ROOT, source))) return target;
		const kind = statSync(join(ROOT, source)).isDirectory() ? "tree" : "blob";
		return `${REPO_URL}/${kind}/main/${source.replace(/\/$/, "")}${anchor ? `#${anchor}` : ""}`;
	};
	return html
		.replace(/(href|src|poster)="([^"]+)"/g, (_all, attribute: string, target: string) => `${attribute}="${rewrite(target)}"`)
		.replace(/srcset="([^"]+)"/g, (_all, list: string) => `srcset="${list.replace(/^\S+/, (url) => rewrite(url))}"`);
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fill(values: Record<string, string>): string {
	return readFileSync(join(SITE, "templates", "page.html"), "utf8").replace(/\{\{(\w+)\}\}/g, (_all, key: string) => values[key] ?? "");
}

function packageNav(packages: SitePackage[], root: string, current?: string): string {
	return packages.map((pkg) => `<a href="${root}${pkg.folder}/index.html"${pkg.folder === current ? ' aria-current="page"' : ""}>${pkg.folder}</a>`).join("");
}

function sidebar(pkg: SitePackage, page: SitePage, root: string): string {
	const groups = (["Overview", "Docs", "Design"] as const).map((group) => {
		const items = pkg.pages
			.filter((candidate) => candidate.group === group)
			.map((candidate) => {
				const current = candidate.out === page.out ? ' aria-current="page"' : "";
				const title = group === "Overview" ? "Overview" : candidate.title;
				return `<li><a href="${root}${candidate.out}"${current}>${escapeHtml(title)}</a></li>`;
			});
		const extra: Array<[boolean, string, string]> = [
			[pkg.explainer, "explain.html", "Try it in the browser"],
			[pkg.live, "try.html", "Run it live"],
		];
		if (group === "Overview")
			for (const [present, file, title] of extra) {
				if (!present) continue;
				const current = page.out === `${pkg.folder}/${file}` ? ' aria-current="page"' : "";
				items.push(`<li><a href="${root}${pkg.folder}/${file}"${current}>${title}</a></li>`);
			}
		return items.length ? `<h2>${group}</h2><ul>${items.join("")}</ul>` : "";
	});
	return `<aside class="sidebar">${groups.join("")}</aside>`;
}

function tryBox(pkg: SitePackage): string {
	const items = [
		pkg.explainer ? `<li><a href="explain.html">The explainer</a> runs ${pkg.folder}'s own code on your config, in the page.</li>` : "",
		pkg.live ? `<li><a href="try.html">Run it live</a>: real pi and ${pkg.folder} in a container in your browser, with demo accounts.</li>` : "",
	].join("");
	return items ? `<section class="try"><h2>Try it in the browser</h2><ul>${items}</ul></section>` : "";
}

function landing(packages: SitePackage[], copies: Set<string>): string {
	const cards = packages.map((pkg) => {
		const cover = `packages/${pkg.folder}/media/cover.png`;
		let image = "";
		if (existsSync(join(ROOT, cover))) {
			copies.add(cover);
			image = `<img src="${pkg.folder}/media/cover.png" alt="">`;
		}
		return `<article class="card" style="--card-accent: ${pkg.accent}">${image}<div class="body"><h2>${pkg.folder}</h2><p>${escapeHtml(pkg.pitch)}</p><pre><code>pi install npm:${pkg.name}</code></pre><a class="more" href="${pkg.folder}/index.html">Read more →</a></div></article>`;
	});
	const content = `<h1>Extensions for pi: route every request, guard every account</h1>
<p class="lede">Two extensions for <a href="https://pi.dev">pi</a>, the coding agent. MIT licensed, tested on Node 22.19 and later, each installed with one command.</p>
<div class="cards">${cards.join("\n")}</div>`;
	return fill({
		title: "pi-extensions: route every request, guard every account",
		description: "pi-switchboard and pi-account-guard, extensions for the pi coding agent.",
		root: "",
		icon: "assets/mark.svg",
		kind: "landing",
		accent: "var(--brass)",
		packages: packageNav(packages, ""),
		content,
	});
}

function llmsText(packages: SitePackage[]): string {
	const sections = packages.map((pkg) => {
		const links = pkg.pages.map(
			(page) => `- [${page.title}](${page.source.replace(/^packages\//, "")})${page.group === "Overview" ? `: ${pkg.pitch}` : ""}`,
		);
		return `## ${pkg.folder}\n\nInstall: \`pi install npm:${pkg.name}\`\n\n${links.join("\n")}`;
	});
	return `# pi-extensions\n\n> Extensions for pi, the coding agent. ${packages.map((pkg) => `${pkg.folder}: ${pkg.pitch}`).join(" ")}\n\nEach link is the Markdown source of a page of this site.\n\n${sections.join("\n\n")}\n`;
}

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/**
 * The explainers' code: the packages' own modules, compiled by tsc for the
 * browser with their `.ts` imports rewritten, under `<out>/explain/` in the
 * repository's layout.
 */
function compileExplainers(out: string): void {
	execFileSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", join(ROOT, "tools", "site", "tsconfig.explainers.json"), "--outDir", join(out, "explain")], {
		stdio: "inherit",
	});
}

/** An explainer page: its fragment in the site template, with `{{file:<path>}}` replaced by that repository file, escaped. */
function explainerPage(pkg: SitePackage, packages: SitePackage[]): string {
	const fragment = readFileSync(join(SITE, "explainers", `${pkg.folder}.html`), "utf8");
	const content = fragment.replace(/\{\{file:([^}]+)\}\}/g, (_all, path: string) => escapeHtml(readFileSync(join(ROOT, path), "utf8")));
	const page: SitePage = { source: "", out: `${pkg.folder}/explain.html`, title: "Try it", group: "Overview" };
	return fill({
		title: `Try ${pkg.folder} in the browser`,
		description: pkg.pitch,
		root: "../",
		icon: `${pkg.folder}/mark.svg`,
		kind: "package explain",
		accent: pkg.accent,
		packages: packageNav(packages, "../", pkg.folder),
		sidebar: sidebar(pkg, page, "../"),
		content,
	});
}

/** A live try-it page: its fragment in the site template, with cross-origin isolation for the WebContainer and the terminal's styles. */
function livePage(pkg: SitePackage, packages: SitePackage[]): string {
	const page: SitePage = { source: "", out: `${pkg.folder}/try.html`, title: "Run it live", group: "Overview" };
	return fill({
		title: `Run ${pkg.folder} live in the browser`,
		description: pkg.pitch,
		root: "../",
		icon: `${pkg.folder}/mark.svg`,
		// coi-serviceworker reloads the page once with the isolation headers a static host cannot send.
		head: '<script src="../coi-serviceworker.js"></script>\n<link rel="stylesheet" href="../vendor/xterm/xterm.css">',
		kind: "package live",
		accent: pkg.accent,
		packages: packageNav(packages, "../", pkg.folder),
		sidebar: sidebar(pkg, page, "../"),
		content: readFileSync(join(SITE, "try", `${pkg.folder}.html`), "utf8"),
	});
}

/** The browser code the live pages load: xterm.js, its fit addon, the WebContainer API, the isolation worker and the page runtime. */
function copyLiveRuntime(out: string): void {
	const modules = join(ROOT, "node_modules");
	const copies: Array<[string, string]> = [
		[join(modules, "@xterm", "xterm", "lib", "xterm.js"), "vendor/xterm/xterm.js"],
		[join(modules, "@xterm", "xterm", "css", "xterm.css"), "vendor/xterm/xterm.css"],
		[join(modules, "@xterm", "addon-fit", "lib", "addon-fit.js"), "vendor/xterm/addon-fit.js"],
		[join(modules, "coi-serviceworker", "coi-serviceworker.min.js"), "coi-serviceworker.js"],
		[join(SITE, "try", "runtime.js"), "try/runtime.js"],
	];
	for (const [from, to] of copies) {
		mkdirSync(dirname(join(out, to)), { recursive: true });
		copyFileSync(from, join(out, to));
	}
	cpSync(join(modules, "@webcontainer", "api", "dist"), join(out, "vendor", "webcontainer"), { recursive: true, filter: (path) => !/\.d\.ts$/.test(path) });
}

/** Builds the site into `out` and returns the problems the link check found (none on success). */
export function buildSite(out: string): string[] {
	rmSync(out, { recursive: true, force: true });
	const packages = sitePackages();
	const pages = new Map(packages.flatMap((pkg) => pkg.pages.map((page) => [page.source, page.out] as const)));
	const copies = new Set<string>();
	for (const pkg of packages) {
		for (const page of pkg.pages) {
			const markdown = readFileSync(join(ROOT, page.source), "utf8");
			const root = "../".repeat(page.out.split("/").length - 1);
			const body = rewriteLinks(renderMarkdown(markdown), page, pages, copies);
			const mark = existsSync(join(ROOT, "packages", pkg.folder, "media", "src", "mark.svg")) ? `${pkg.folder}/mark.svg` : "assets/mark.svg";
			write(
				join(out, page.out),
				fill({
					title: page.group === "Overview" ? `${pkg.folder}: ${pkg.pitch}` : `${page.title} · ${pkg.folder}`,
					description: pkg.pitch,
					root,
					icon: mark,
					kind: "package",
					accent: pkg.accent,
					packages: packageNav(packages, root, pkg.folder),
					sidebar: sidebar(pkg, page, root),
					content: page.group === "Overview" ? body.replace(/(<\/h1>)/, `$1\n${tryBox(pkg)}`) : body,
				}),
			);
			write(join(out, page.source.replace(/^packages\//, "")), markdown);
		}
		const mark = join(ROOT, "packages", pkg.folder, "media", "src", "mark.svg");
		if (existsSync(mark)) copyFileSync(mark, join(out, pkg.folder, "mark.svg"));
		if (pkg.explainer) write(join(out, pkg.folder, "explain.html"), explainerPage(pkg, packages));
		if (pkg.live) {
			write(join(out, pkg.folder, "try.html"), livePage(pkg, packages));
			mkdirSync(join(out, pkg.folder, "try"), { recursive: true });
			copyFileSync(join(SITE, ".snapshots", `${pkg.folder}.snapshot.gz`), join(out, pkg.folder, "try", "snapshot.gz"));
		}
	}
	if (packages.some((pkg) => pkg.explainer)) compileExplainers(out);
	if (packages.some((pkg) => pkg.live)) copyLiveRuntime(out);
	write(join(out, "index.html"), landing(packages, copies));
	write(join(out, "llms.txt"), llmsText(packages));
	for (const source of copies) {
		if (!existsSync(join(ROOT, source))) continue;
		mkdirSync(dirname(join(out, source.replace(/^packages\//, ""))), { recursive: true });
		copyFileSync(join(ROOT, source), join(out, source.replace(/^packages\//, "")));
	}
	mkdirSync(join(out, "assets"), { recursive: true });
	copyFileSync(join(ROOT, "tools", "brand", "tokens.css"), join(out, "assets", "tokens.css"));
	copyFileSync(join(SITE, "assets", "site.css"), join(out, "assets", "site.css"));
	copyFileSync(join(SITE, "assets", "mark.svg"), join(out, "assets", "mark.svg"));
	// Pages publishes the folder as it is; without this file it would run Jekyll over it.
	write(join(out, ".nojekyll"), "");
	return checkSiteLinks(out);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const out = resolve(process.argv[2] ?? join(SITE, "dist"));
	const problems = buildSite(out);
	for (const problem of problems) console.error(`  - ${problem}`);
	if (problems.length > 0) {
		console.error(`site: ${problems.length} broken link(s) in ${relative(ROOT, out)}`);
		process.exit(1);
	}
	console.log(`site: built ${relative(ROOT, out) || out}`);
}
