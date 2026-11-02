import { type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";
import { approvalState, approvalsFor, hashDefinition, readApprovals } from "../core/approval.ts";
import { BUILTIN_REFS } from "../core/builtins.ts";
import { projectRefProblem } from "../core/confine.ts";
import { type DoctorFacts, doctorLines, type EditorState, type LibraryFact } from "../core/doctor.ts";
import { refDefinition } from "../core/expand.ts";
import { readSettings, settingsProblems } from "../core/ref-list.ts";
import { approvalsFile, projectKey } from "./approvals.ts";
import { needsApproval } from "./ref-approvals.ts";
import { type Run, readListed } from "./ref-run.ts";

/** What `/ref doctor` needs from outside the command's own files. */
export interface DoctorEnv {
	/** Whether a Placeholder is one unit in the editor now (EditorTap.status). */
	editorStatus: (ctx: Pick<ExtensionContext, "ui" | "hasUI">) => EditorState;
	/** Whether a directory is inside a git work tree. */
	isGitWorkTree: (cwd: string) => Promise<boolean>;
}

/** What a library file holds, as the doctor reports it. */
function factOf(read: ReturnType<typeof readListed>): LibraryFact {
	const { listed, text } = read;
	return {
		path: listed.file,
		exists: text !== undefined || listed.error !== undefined,
		refs: listed.refs.length,
		warnings: listed.warnings,
		...(listed.error === undefined ? {} : { error: listed.error }),
	};
}

/** Whether the Project library file is there, without loading anything from it: pi does not trust the project, so nothing in it counts. */
function presentWithoutLoading(run: Run): boolean {
	try {
		return run.files.project.read() !== undefined;
	} catch {
		return true;
	}
}

/**
 * The facts `/ref doctor` reports. It reads the two libraries, the approvals file and git, and writes nothing, runs no ref and fetches nothing.
 * A file that cannot be read becomes a fact, never an exception.
 */
export async function gatherDoctorFacts(run: Run, env: DoctorEnv, sessionTrigger: string): Promise<DoctorFacts> {
	// The editor is read before anything that waits (the git check starts a program), so the report is about the moment the command was run.
	const editor = env.editorStatus(run.ctx);
	const global = readListed(run.files.global);
	const projectRead = run.trusted ? readListed(run.files.project, (ref) => projectRefProblem(ref, run.place)) : undefined;
	const approvalsAt = approvalsFile(run.deps);
	const approvals = readApprovals(approvalsAt);
	const project = projectKey(run.deps, run.ctx.cwd);
	const sourceRefs = (projectRead?.listed.refs ?? []).filter(needsApproval);
	const pending = sourceRefs
		.filter((ref) => !approvals.ok || approvalState(approvals.approvals, project, ref.name, hashDefinition(refDefinition(ref, run.place))) === "pending")
		.map((ref) => ref.name);
	const settings = readSettings(global.text);
	const everyBuiltin = BUILTIN_REFS.map((ref) => ref.name);
	const builtinsOff =
		settings.builtins === true
			? []
			: settings.builtins === false
				? everyBuiltin
				: everyBuiltin.filter((name) => (settings.builtins as string[]).includes(name));
	return {
		global: factOf(global),
		project: projectRead ? { trusted: true, ...factOf(projectRead) } : { trusted: false, path: run.files.project.path, exists: presentWithoutLoading(run) },
		approvals: approvals.ok
			? { path: approvalsAt.path, count: approvalsFor(approvals.approvals, project).length }
			: { path: approvalsAt.path, count: 0, error: approvals.error },
		pending,
		git: { inWorkTree: await env.isGitWorkTree(run.ctx.cwd).catch(() => false), builtinsOff },
		editor,
		trigger: { configured: settings.trigger, session: sessionTrigger, problems: settingsProblems(global.text) },
		versions: { pi: VERSION, node: process.version, ui: run.ctx.hasUI },
	};
}

/** `/ref doctor`: what is set up, what is wrong and what to do about it. Changes nothing. */
export async function doctor(run: Run, env: DoctorEnv, sessionTrigger: string): Promise<void> {
	run.say(doctorLines(await gatherDoctorFacts(run, env, sessionTrigger)).join("\n"));
}
