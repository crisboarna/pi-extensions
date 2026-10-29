// PROTOTYPE, throwaway. It answers "How do the picker and the Placeholder look and behave in the
// editor?" (https://github.com/crisboarna/pi-extensions/issues/168) and is never merged.
// Three Placeholder routes x three labels x two pickers, switched with /proto. The Ref library is
// fake and in memory, and a stub model echoes what it received, so nothing leaves the machine.
// How to run it and what to try: README.md next to this file.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model, type TranscriptContext } from "@earendil-works/pi-ai/compat";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type Component,
	Editor,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type Kind = "path" | "file" | "snippet" | "dynamic";
type Layer = "scoped" | "project" | "global" | "recent";
type Route = "atomic" | "chip" | "token";
type Picker = "inline" | "overlay";
type Ui = ExtensionContext["ui"];

interface Ref {
	name: string;
	kind: Kind;
	layer: Layer;
	target: string;
	note: string;
	tags: string[];
}

type Choice = { type: "ref"; ref: Ref } | { type: "bundle"; tag: string; members: Ref[] };

// The TS-private Editor members routes A and B reach. pi 1.4.0 only; none is public API.
interface EditorInternals {
	pastes: Map<number, string>;
	pasteCounter: number;
	segment(text: string, mode?: string): Iterable<Intl.SegmentData>;
	insertTextAtCursor(text: string): void;
	render(width: number): string[];
	handleInput(data: string): void;
}

const LIBRARY: Ref[] = [
	{
		name: "review",
		kind: "snippet",
		layer: "scoped",
		target: "Review the diff for correctness first, then naming, then tests. List findings by severity.",
		note: "my checklist for this repo",
		tags: ["review"],
	},
	{ name: "guardrails", kind: "file", layer: "project", target: "docs/guardrails.md", note: "every gate and why", tags: ["onboarding", "review"] },
	{ name: "commits", kind: "file", layer: "project", target: "docs/conventions/commits.md", note: "commit message rules", tags: ["review"] },
	{ name: "packages-dir", kind: "path", layer: "project", target: "packages/", note: "where packages live", tags: [] },
	{ name: "agents", kind: "file", layer: "global", target: "AGENTS.md", note: "this repo's agent rules", tags: ["onboarding"] },
	{ name: "review", kind: "snippet", layer: "global", target: "Review this.", note: "generic review (shadowed here)", tags: [] },
	{ name: "terse", kind: "snippet", layer: "global", target: "Answer in at most five bullets.", note: "standing instruction", tags: [] },
	{ name: "git-diff", kind: "dynamic", layer: "global", target: "git diff --stat", note: "runs on send (stubbed)", tags: ["review"] },
];

const RECENT: Ref[] = [
	{ name: "README.md", kind: "path", layer: "recent", target: "README.md", note: "read by a tool 2 min ago", tags: [] },
	{ name: "scripts/check.ts", kind: "path", layer: "recent", target: "scripts/check.ts", note: "edited 5 min ago", tags: [] },
];

const ROUTES: Route[] = ["atomic", "chip", "token"];
const ROUTE_NAMES: Record<Route, string> = {
	atomic: "A atomic text (segment override)",
	chip: "B paste chip (pi's paste store, label drawn on screen)",
	token: "C plain #name token (no editor internals)",
};
const LABELS = ["[Context Ref N]", "[ref:name]", "[Context Ref N: name]"];
const RANK: Record<Layer, number> = { scoped: 0, project: 1, global: 2, recent: 3 };
const MARK: Record<Layer, string> = { scoped: "◆", project: "■", global: "●", recent: "↺" };
const KIND: Record<Kind, string> = { path: "path", file: "file", snippet: "text", dynamic: "run " };
const VALUE = "ctxref-proto:";

const proto = { route: "atomic" as Route, label: 0, picker: "inline" as Picker };
const draft = { next: 1, labels: new Map<string, Ref>(), chips: new Map<number, string>() };
let activeEditor: EditorInternals | undefined;
let ui: Ui | undefined;
let lastChoices = new Map<string, Choice>();

function visibleRefs(): Ref[] {
	const seen = new Set<string>();
	const out: Ref[] = [];
	for (const ref of [...LIBRARY].sort((a, b) => RANK[a.layer] - RANK[b.layer])) {
		const key = ref.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	return out;
}

function bundles(): Choice[] {
	const tags = new Map<string, Ref[]>();
	for (const ref of visibleRefs()) for (const tag of ref.tags) tags.set(tag, [...(tags.get(tag) ?? []), ref]);
	return [...tags].map(([tag, members]) => ({ type: "bundle", tag, members }));
}

function choices(query: string): Choice[] {
	const all: Choice[] = [...visibleRefs(), ...RECENT].map((ref) => ({ type: "ref" as const, ref }));
	all.push(...bundles());
	if (!query) return all;
	const found = fuzzyFilter(all, query, (c) => (c.type === "ref" ? `${c.ref.name} ${c.ref.note} ${c.ref.tags.join(" ")}` : `tag:${c.tag}`));
	// Keep each section together; the sort is stable, so relevance order holds within a section.
	return found.sort((a, b) => (a.type === "ref" ? RANK[a.ref.layer] : 4) - (b.type === "ref" ? RANK[b.ref.layer] : 4));
}

function refsOf(choice: Choice): Ref[] {
	return choice.type === "ref" ? [choice.ref] : choice.members;
}

function describe(choice: Choice): { label: string; description: string } {
	if (choice.type === "bundle") return { label: `⧉ tag:${choice.tag}`, description: `bundle · ${choice.members.map((r) => r.name).join(", ")}` };
	const { ref } = choice;
	return { label: `${MARK[ref.layer]} ${ref.name}`, description: `${KIND[ref.kind]} · ${ref.layer} · ${ref.note}` };
}

function readCapped(path: string): string {
	try {
		const text = readFileSync(path, "utf8");
		return text.length > 1500 ? `${text.slice(0, 1500)}\n…(truncated by the prototype)` : text;
	} catch {
		return "(missing file)";
	}
}

function expansion(ref: Ref, cwd: string): string {
	const body =
		ref.kind === "file" ? readCapped(resolve(cwd, ref.target)) : ref.kind === "dynamic" ? `(prototype stub: would run \`${ref.target}\` now)` : ref.target;
	return `<context-ref name="${ref.name}" kind="${ref.kind}" layer="${ref.layer}">\n${body}\n</context-ref>`;
}

function labelFor(ref: Ref): string {
	const n = draft.next++;
	if (proto.label === 1) return `[ref:${ref.name}]`;
	if (proto.label === 2) return `[Context Ref ${n}: ${ref.name}]`;
	return `[Context Ref ${n}]`;
}

function resetDraft(): void {
	draft.next = 1;
	draft.labels.clear();
	draft.chips.clear();
}

function refresh(): void {
	if (!ui) return;
	const head = `context-refs prototype · ${ROUTE_NAMES[proto.route]} · label ${LABELS[proto.label]} · picker ${proto.picker} · /proto to switch, alt+r opens the overlay`;
	const rows =
		proto.route === "chip"
			? [...draft.chips].map(([id, label]) => `  buffer [paste #${id} …] drawn as ${label}`)
			: [...draft.labels].map(([label, ref]) => `  ${label} → ${ref.name} (${ref.kind}, ${ref.layer})`);
	ui.setWidget("ctxref-proto", rows.length ? [head, "  inserted in this draft (deleted ones stay listed):", ...rows] : [head]);
	ui.setStatus("ctxref-proto", `refs proto ${proto.route}/${proto.label + 1}/${proto.picker}`);
}

function insertRef(editor: EditorInternals, ref: Ref, cwd: string): void {
	if (proto.route === "token") {
		editor.insertTextAtCursor(`#${ref.name} `);
		return;
	}
	if (proto.route === "atomic") {
		const label = labelFor(ref);
		draft.labels.set(label, ref);
		editor.insertTextAtCursor(`${label} `);
		return;
	}
	// Route B snapshots the content now: pi expands the marker itself before the input event runs.
	const body = expansion(ref, cwd);
	const id = editor.pasteCounter + 1;
	editor.pasteCounter = id;
	editor.pastes.set(id, body);
	draft.chips.set(id, labelFor(ref));
	editor.insertTextAtCursor(`[paste #${id} ${body.length} chars] `);
}

function insertChoice(choice: Choice, cwd: string): void {
	if (!activeEditor) {
		ui?.notify("prototype: another extension owns the editor, so nothing was inserted", "warning");
		return;
	}
	for (const ref of refsOf(choice)) insertRef(activeEditor, ref, cwd);
	refresh();
}

function mergeLabels(segments: Iterable<Intl.SegmentData>, text: string): Iterable<Intl.SegmentData> {
	const spans: Array<[number, number]> = [];
	for (const label of draft.labels.keys()) {
		for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + label.length)) spans.push([at, at + label.length]);
	}
	if (spans.length === 0) return segments;
	const out: Intl.SegmentData[] = [];
	for (const seg of segments) {
		const span = spans.find(([start, end]) => seg.index >= start && seg.index < end);
		if (!span) out.push(seg);
		else if (seg.index === span[0]) out.push({ segment: text.slice(span[0], span[1]), index: span[0], input: text });
	}
	return out;
}

function fit(label: string, width: number): string {
	if (label.length >= width) return `${label.slice(0, width - 2)}…]`;
	return label.padEnd(width, " ");
}

// Decorates whatever editor the slot already holds, as pi-image-view and pix-display do.
function decorate(editor: EditorInternals): void {
	const baseSegment = (Editor.prototype as unknown as EditorInternals).segment;
	const baseRender = editor.render.bind(editor);
	editor.segment = (text, mode) => {
		const segments = baseSegment.call(editor, text, mode);
		return proto.route === "atomic" ? mergeLabels(segments, text) : segments;
	};
	editor.render = (width) => {
		const lines = baseRender(width);
		if (proto.route !== "chip" || draft.chips.size === 0) return lines;
		return lines.map((line) =>
			line.replace(/\[paste #(\d+) (\d+) chars\]/g, (marker, id: string) => {
				const label = draft.chips.get(Number(id));
				return label ? fit(label, marker.length) : marker;
			}),
		);
	};
}

class PickerOverlay implements Component {
	private query = "";
	private index = 0;
	private readonly finish: (choice: Choice | undefined) => void;
	private readonly redraw: () => void;
	private readonly cwd: string;

	constructor(finish: (choice: Choice | undefined) => void, redraw: () => void, cwd: string) {
		this.finish = finish;
		this.redraw = redraw;
		this.cwd = cwd;
	}

	handleInput(data: string): void {
		const rows = choices(this.query);
		if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
			this.finish(matchesKey(data, "enter") ? rows[this.index] : undefined);
			return;
		}
		if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
		else if (matchesKey(data, "down")) this.index = Math.min(rows.length - 1, this.index + 1);
		else if (matchesKey(data, "backspace")) this.query = this.query.slice(0, -1);
		else if (data.length === 1 && data >= " ") this.query += data;
		this.index = Math.min(this.index, Math.max(0, choices(this.query).length - 1));
		this.redraw();
	}

	render(width: number): string[] {
		const rows = choices(this.query);
		const inner = Math.max(20, width - 4);
		const line = (text: string) => `│ ${truncateToWidth(text, inner).padEnd(inner + text.length - visibleWidth(text), " ")} │`;
		const out = [`╭${"─".repeat(inner + 2)}╮`, line(`Context refs   #${this.query}▏   type to filter · ↑↓ · enter · esc`), line("")];
		let section = "";
		const start = Math.max(0, Math.min(this.index - 6, rows.length - 12));
		rows.slice(start, start + 12).forEach((choice, i) => {
			const name = choice.type === "bundle" ? "BUNDLES" : choice.ref.layer.toUpperCase();
			if (name !== section) {
				section = name;
				out.push(line(name));
			}
			const { label, description } = describe(choice);
			out.push(line(`${start + i === this.index ? "▸" : " "} ${label.padEnd(20, " ")} ${description}`));
		});
		if (rows.length === 0) out.push(line("  no match: Enter does nothing, Esc keeps the #"));
		const selected = rows[this.index];
		if (selected) {
			out.push(line(""), line("── preview ──"));
			const preview = refsOf(selected)
				.map((ref) => expansion(ref, this.cwd))
				.join("\n")
				.split("\n")
				.slice(0, 8);
			for (const text of preview) out.push(line(text));
		}
		out.push(`╰${"─".repeat(inner + 2)}╯`);
		return out;
	}

	invalidate(): void {}
}

async function openOverlay(ctx: ExtensionContext, removeHash: boolean): Promise<void> {
	const choice = await ctx.ui.custom<Choice | undefined>((tui, _theme, _keybindings, done) => new PickerOverlay(done, () => tui.requestRender(), ctx.cwd), {
		overlay: true,
	});
	if (!choice) return;
	if (removeHash) activeEditor?.handleInput("\x7f");
	insertChoice(choice, ctx.cwd);
}

function provider(current: AutocompleteProvider, ctx: ExtensionContext): AutocompleteProvider {
	return {
		triggerCharacters: ["#"],
		async getSuggestions(lines, line, col, options) {
			const match = (lines[line] ?? "").slice(0, col).match(/(?:^|[ \t])#([A-Za-z0-9._:/-]*)$/);
			const query = match?.[1];
			// Numeric tokens (#123) and lines without a # token go down the chain, as decided.
			if (query === undefined || /^\d+$/.test(query)) return current.getSuggestions(lines, line, col, options);
			if (proto.picker === "overlay" && query === "") {
				queueMicrotask(() => void openOverlay(ctx, true));
				return null;
			}
			const found = choices(query.replace(/^tag:/, ""));
			if (found.length === 0) return current.getSuggestions(lines, line, col, options);
			lastChoices = new Map(found.map((choice, i) => [`${VALUE}${i}`, choice]));
			const items: AutocompleteItem[] = found.map((choice, i) => ({ value: `${VALUE}${i}`, ...describe(choice) }));
			return { items, prefix: `#${query}` };
		},
		applyCompletion(lines, line, col, item, prefix) {
			const choice = lastChoices.get(item.value);
			if (!choice) return current.applyCompletion(lines, line, col, item, prefix);
			const text = lines[line] ?? "";
			const next = [...lines];
			next[line] = text.slice(0, col - prefix.length) + text.slice(col);
			// The editor applies these lines first; the Placeholder goes in right after.
			queueMicrotask(() => insertChoice(choice, ctx.cwd));
			return { lines: next, cursorLine: line, cursorCol: col - prefix.length };
		},
		shouldTriggerFileCompletion(lines, line, col) {
			return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
		},
	};
}

function findRefs(name: string, bundle: boolean): Ref[] {
	const key = name.toLowerCase();
	if (bundle) return visibleRefs().filter((ref) => ref.tags.includes(key));
	return [...visibleRefs(), ...RECENT].filter((ref) => ref.name.toLowerCase() === key).slice(0, 1);
}

function expandMessage(text: string, cwd: string): string {
	// A token ends at whitespace or punctuation; a trailing "." is sentence punctuation, not part of the name.
	let out = text.replace(
		/(^|\s)#(tag:)?([A-Za-z0-9._/-]+?)(\.*)(?=[\s,;:!?)\]]|$)/g,
		(token, lead: string, tag: string | undefined, name: string, dots: string) => {
			const refs = findRefs(name, tag !== undefined);
			return refs.length ? lead + refs.map((ref) => expansion(ref, cwd)).join("\n") + dots : token;
		},
	);
	for (const [label, ref] of draft.labels) out = out.split(label).join(expansion(ref, cwd));
	return out;
}

function lastUserText(context: TranscriptContext): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
	}
	return "(no user message)";
}

function echo(model: Model<Api>, context: TranscriptContext) {
	const stream = createAssistantMessageEventStream();
	const reply = `The model received this user message:\n\n\`\`\`\`text\n${lastUserText(context)}\n\`\`\`\``;
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		message.content = [{ type: "text", text: reply }];
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: message });
		message.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

export default function contextRefsPrototype(pi: ExtensionAPI): void {
	pi.registerProvider("ctxref-proto", {
		name: "Context refs prototype",
		baseUrl: "http://stub.invalid",
		apiKey: "stub-not-a-secret",
		api: "ctxref-proto-api",
		streamSimple: echo,
		models: [
			{
				id: "echo",
				name: "echo (prototype stub)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 4000,
			},
		],
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ui = ctx.ui;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
			activeEditor = editor instanceof Editor ? (editor as unknown as EditorInternals) : undefined;
			if (activeEditor) decorate(activeEditor);
			return editor;
		});
		ctx.ui.addAutocompleteProvider((current) => provider(current, ctx));
		refresh();
	});

	pi.on("input", (event, ctx) => {
		const text = expandMessage(event.text, ctx.cwd);
		resetDraft();
		refresh();
		if (text === event.text) return { action: "continue" };
		return event.images ? { action: "transform", text, images: event.images } : { action: "transform", text };
	});

	pi.registerShortcut("alt+r", { description: "Open the context-refs picker overlay (prototype)", handler: (ctx) => openOverlay(ctx, false) });

	pi.registerCommand("proto", {
		description: "Context-refs prototype: /proto route [atomic|chip|token], /proto label [1|2|3], /proto picker [inline|overlay], /proto shadowed",
		handler: async (args, ctx) => {
			const [what, value] = args.trim().split(/\s+/);
			if (what === "shadowed") {
				const visible = new Set(visibleRefs());
				const hidden = LIBRARY.filter((ref) => !visible.has(ref)).map((ref) => `#${ref.name} (${ref.layer})`);
				ctx.ui.notify(`Shadowed: ${hidden.join(", ") || "none"}`, "info");
				return;
			}
			if (what === "route") proto.route = ROUTES.find((r) => r === value) ?? ROUTES[(ROUTES.indexOf(proto.route) + 1) % ROUTES.length] ?? "atomic";
			else if (what === "label") proto.label = value ? Math.min(2, Math.max(0, Number(value) - 1)) : (proto.label + 1) % LABELS.length;
			else if (what === "picker") proto.picker = value === "inline" || value === "overlay" ? value : proto.picker === "inline" ? "overlay" : "inline";
			resetDraft();
			refresh();
			ctx.ui.notify(
				`${ROUTE_NAMES[proto.route]} · label ${LABELS[proto.label]} · picker ${proto.picker}. The draft's Placeholders were forgotten; clear the editor.`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", () => {
		ui = undefined;
		activeEditor = undefined;
	});
}
