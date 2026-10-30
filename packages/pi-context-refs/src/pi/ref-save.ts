import { foldName, nameProblem } from "../core/names.ts";
import { suggestRefName } from "../core/suggest-name.ts";
import { saveNewRef } from "./commands.ts";
import { entryNames, type Run, targetOf } from "./ref-run.ts";

const AS_FILE = "File: send its contents";
const AS_PATH = "Path: insert its path";

/**
 * Saves a file from the Recent rows through the add flow, in the Global library: asks for a File or a Path Ref, then for the name, which
 * starts as the file name made fit for a name and is asked again until it is valid and free. `shown` is the path as the row shows it.
 */
export async function saveUsedFile(run: Run, shown: string): Promise<void> {
	const target = targetOf(run, "global");
	if ("error" in target) return run.say(target.error, "error");
	const { ui } = run.ctx;
	const cancelled = (): void => run.say("Cancelled; nothing was saved");
	const chosen = await ui.select(`Save ${shown} as`, [AS_FILE, AS_PATH]);
	if (chosen === undefined) return cancelled();
	const kind = chosen === AS_FILE ? "file" : "path";
	const taken = (name: string): boolean => entryNames(target.file).some((existing) => foldName(existing) === foldName(name));
	let name = suggestRefName(shown, taken);
	let title = `Name of the ${kind} Ref for ${shown}`;
	for (;;) {
		const answer = await ui.editor(title, name);
		if (answer === undefined) return cancelled();
		name = answer.trim();
		const problem = nameProblem(name) ?? (taken(name) ? `"${name}" is already in ${target.phrase}` : undefined);
		if (problem === undefined) break;
		title = `Name of the ${kind} Ref for ${shown}: ${problem}`;
	}
	await saveNewRef(run, target, { refName: name, kind, target: [shown], fields: [] });
}
