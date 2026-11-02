import { BUILTIN_REFS } from "./builtins.ts";

/** The editor states the doctor can report; `EditorTap.status` produces them (src/pi/editor.ts). */
export type EditorState = "no-ui" | "pending" | "atomic" | "plain:no-segment" | "plain:replaced";

/** What the doctor knows about one library file. */
export interface LibraryFact {
	path: string;
	exists: boolean;
	refs: number;
	warnings: string[];
	/** Set when the file cannot be used at all. */
	error?: string;
}

/** What `/ref doctor` checks, gathered from the machine by src/pi/doctor.ts and formatted by `doctorLines`. */
export interface DoctorFacts {
	global: LibraryFact;
	/** The Project library: not loaded when pi does not trust the project, else read like the Global library. */
	project: (LibraryFact & { trusted: true }) | { trusted: false; path: string; exists: boolean };
	approvals: { path: string; count: number; error?: string };
	/** The Project command and address refs with no Approval of their current definition, by name. */
	pending: string[];
	git: { inWorkTree: boolean /** The built-in refs the `builtins` setting turns off, by name. */; builtinsOff: string[] };
	editor: EditorState;
	trigger: { configured: string; session: string; problems: string[] };
	versions: { pi: string; node: string; ui: boolean };
}

interface Lines {
	ok: string[];
	warn: string[];
	bad: string[];
}

const refs = (count: number): string => `${count} ref${count === 1 ? "" : "s"}`;

/** "#a", "#a and #b", "#a, #b and #c". */
function andList(names: readonly string[]): string {
	const marked = names.map((name) => `#${name}`);
	return marked.length <= 1 ? marked.join("") : `${marked.slice(0, -1).join(", ")} and ${marked.at(-1)}`;
}

function globalLines(fact: LibraryFact, out: Lines): void {
	if (fact.error !== undefined) return void out.bad.push(`✗ Global library: ${fact.error}`);
	if (!fact.exists) out.ok.push(`✓ Global library: none yet (${fact.path}); /ref add creates it`);
	else out.ok.push(`✓ Global library: ${refs(fact.refs)} in ${fact.path}`);
	for (const warning of fact.warnings) out.warn.push(`! Global library: ${warning}`);
}

function projectLines(project: DoctorFacts["project"], out: Lines): void {
	if (!project.trusted) {
		if (project.exists)
			out.warn.push(`! Project library: ${project.path} is not loaded because pi does not trust this project; run /trust, then restart pi`);
		else out.ok.push(`✓ Project library: none (${project.path})`);
		return;
	}
	if (project.error !== undefined) return void out.bad.push(`✗ Project library: ${project.error}`);
	if (!project.exists) out.ok.push(`✓ Project library: none (${project.path})`);
	else out.ok.push(`✓ Project library: ${refs(project.refs)} in ${project.path}`);
	for (const warning of project.warnings) out.warn.push(`! Project library: ${warning}`);
}

function approvalLines(facts: DoctorFacts, out: Lines): void {
	const { approvals, pending } = facts;
	if (approvals.error !== undefined) out.bad.push(`✗ approvals: ${approvals.error}; every Project command asks again until it is fixed or removed`);
	else out.ok.push(`✓ approvals: ${approvals.count === 0 ? "none" : approvals.count} for this project`);
	if (pending.length > 0)
		out.warn.push(
			`! ${pending.length} Project ${pending.length === 1 ? "ref waits" : "refs wait"} for an Approval: ${pending.join(", ")}; send a message that names one from the TUI, or run /ref approve <name>`,
		);
}

function gitLines({ git }: DoctorFacts, out: Lines): void {
	const all = BUILTIN_REFS.map((ref) => ref.name);
	if (!git.inWorkTree) return void out.warn.push(`! git: this directory is not inside a git work tree, so ${andList(all)} are hidden`);
	const on = all.filter((name) => !git.builtinsOff.includes(name));
	if (on.length === 0) out.ok.push("✓ git: every built-in ref is turned off by the builtins setting");
	else if (git.builtinsOff.length === 0) out.ok.push(`✓ git: ${andList(on)} work here`);
	else out.ok.push(`✓ git: ${andList(on)} work here; ${andList(git.builtinsOff)} are turned off by the builtins setting`);
}

function editorLines(editor: EditorState, out: Lines): void {
	switch (editor) {
		case "no-ui":
			return void out.ok.push("✓ editor: this mode has no editor; typed refs still expand");
		case "atomic":
			return void out.ok.push("✓ editor: a placeholder is one unit; one Backspace deletes it");
		case "pending":
			return void out.warn.push("! editor: not wrapped yet; it is wrapped one tick after the session starts, so run /ref doctor again");
		case "plain:no-segment":
			return void out.warn.push(
				"! editor: this pi's editor has no segment method, so a placeholder is plain text; it still expands when you send (ADR 0001)",
			);
		case "plain:replaced":
			return void out.warn.push(
				"! editor: another extension replaced it after the wrap, so Backspace deletes one character; the placeholder still expands (ADR 0007)",
			);
	}
}

function triggerLines({ trigger }: DoctorFacts, out: Lines): void {
	for (const problem of trigger.problems) out.warn.push(`! trigger: ${problem}`);
	if (trigger.configured !== trigger.session)
		out.warn.push(
			`! trigger: the file says ${JSON.stringify(trigger.configured)} but this session started with ${JSON.stringify(trigger.session)}; run /reload`,
		);
	out.ok.push(
		`✓ trigger: ${trigger.session} opens the list; alt+r always opens the overlay; if ${trigger.session} opens nothing, another extension may own the key: set trigger to another character and run /reload`,
	);
}

/** One line per check: ✓ fine, ! worth a look, ✗ a problem, each with what to do. Problems come first. */
export function doctorLines(facts: DoctorFacts): string[] {
	const out: Lines = { ok: [], warn: [], bad: [] };
	globalLines(facts.global, out);
	projectLines(facts.project, out);
	approvalLines(facts, out);
	gitLines(facts, out);
	editorLines(facts.editor, out);
	triggerLines(facts, out);
	out.ok.push(`✓ pi ${facts.versions.pi}, Node ${facts.versions.node}, ${facts.versions.ui ? "with a UI" : "without a UI"}`);
	const summary = out.bad.length > 0 || out.warn.length > 0 ? `${out.bad.length} problem(s), ${out.warn.length} warning(s)` : "everything looks right";
	return [`pi-context-refs doctor: ${summary}`, ...out.bad, ...out.warn, ...out.ok];
}
