/**
 * One subagent task inside a `subagent` tool call, with a setter that writes
 * a model back into the exact place the call holds it.
 */
export interface LaunchTask {
	index: number;
	agent: string;
	task: string;
	/** The model the call already names for this task, if any. */
	model?: string;
	/** Where the task sits: `single`, `parallel`, `tasks` or `chain`. */
	shape: "single" | "parallel" | "tasks" | "chain";
	setModel(model: string): void;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function fromItem(
	item: Json,
	index: number,
	shape: LaunchTask["shape"],
	fallbackTask: string | undefined,
	outerModel: string | undefined,
): LaunchTask | undefined {
	const agent = str(item.agent);
	if (!agent) return undefined;
	const model = str(item.model) ?? outerModel;
	return {
		index,
		agent,
		task: str(item.task) ?? fallbackTask ?? "",
		...(model ? { model } : {}),
		shape,
		setModel: (next) => {
			item.model = next;
		},
	};
}

/**
 * The tasks a `subagent` call launches, for the shapes a hook can route:
 * a single launch, a parallel workflow, and the structured `tasks` and
 * `chain` forms used when workflow scripts are disabled. Management actions
 * and workflow scripts return no tasks.
 */
export function extractTasks(input: unknown): LaunchTask[] {
	if (!isObject(input)) return [];
	const options = isObject(input.options) ? input.options : {};
	if (str(input.action) ?? str(options.action)) return [];
	const outerModel = str(input.model);
	const workflow = input.workflow ?? options.workflow;

	if (workflow === "parallel") {
		const args = isObject(input.args) ? input.args : isObject(options.args) ? options.args : undefined;
		const items = Array.isArray(args?.tasks) ? args.tasks : [];
		return items
			.flatMap((item, index) => (isObject(item) ? [fromItem(item, index, "parallel", undefined, outerModel)] : []))
			.filter((t): t is LaunchTask => t !== undefined);
	}
	if (workflow !== undefined) return [];

	const topTasks = Array.isArray(input.tasks) ? input.tasks : Array.isArray(options.tasks) ? options.tasks : undefined;
	if (topTasks) {
		return topTasks
			.flatMap((item, index) => (isObject(item) ? [fromItem(item, index, "tasks", undefined, outerModel)] : []))
			.filter((t): t is LaunchTask => t !== undefined);
	}

	const chain = Array.isArray(input.chain) ? input.chain : Array.isArray(options.chain) ? options.chain : undefined;
	if (chain) {
		const original = str(input.task);
		const out: LaunchTask[] = [];
		let index = 0;
		for (const step of chain) {
			if (!isObject(step)) continue;
			if (Array.isArray(step.parallel)) {
				for (const item of step.parallel) {
					const task = isObject(item) ? fromItem(item, index++, "chain", original, outerModel) : undefined;
					if (task) out.push(task);
				}
			} else {
				const task = fromItem(step, index++, "chain", original, outerModel);
				if (task) out.push(task);
			}
		}
		return out;
	}

	const agent = str(input.agent);
	if (!agent) return [];
	return [
		{
			index: 0,
			agent,
			task: str(input.task) ?? "",
			...(outerModel ? { model: outerModel } : {}),
			shape: "single",
			setModel: (next) => {
				input.model = next;
			},
		},
	];
}

/** Whether a `subagent` result describes children still running in the background. */
export function isAsyncLaunch(details: unknown): boolean {
	return isObject(details) && (str(details.asyncId) !== undefined || str(details.asyncDir) !== undefined);
}

/** Child run ids and session files from a `subagent` tool result, by task index. */
export function resultLinks(details: unknown): Array<{ index: number; runId?: string; sessionFile?: string; model?: string }> {
	if (!isObject(details)) return [];
	const results = Array.isArray(details.results) ? details.results : [];
	const topRunId = str(details.runId);
	return results.flatMap((result, position) => {
		if (!isObject(result)) return [];
		const index = typeof result.index === "number" ? result.index : position;
		const runId = str(result.runId) ?? topRunId;
		const sessionFile = str(result.sessionFile);
		const model = str(result.model);
		return [{ index, ...(runId ? { runId } : {}), ...(sessionFile ? { sessionFile } : {}), ...(model ? { model } : {}) }];
	});
}
