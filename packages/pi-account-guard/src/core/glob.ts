/** Characters that make a rule path a glob instead of a directory. */
export const GLOB_CHARACTERS = /[*?{]/;

/** One piece of a parsed glob. */
type GlobNode =
	| { kind: "literal"; char: string }
	/** `?`: one character other than `/`. */
	| { kind: "one" }
	/** `*`: any run of characters other than `/`. */
	| { kind: "run" }
	/** `**` as a whole segment followed by `/`: any number of whole segments. */
	| { kind: "segments" }
	/** `/**` at the end: the directory itself and everything below it. */
	| { kind: "below" }
	| { kind: "group"; alternatives: GlobNode[][] };

/** A step of the matching program. `split` continues at both targets. */
type Step =
	| { op: "char"; char: string }
	| { op: "not-slash" }
	| { op: "any" }
	| { op: "split"; first: number; second: number }
	| { op: "jump"; to: number }
	| { op: "match" };

/**
 * Compiles a glob to a test over a whole subject: `*` one segment, `**` any depth, `?` one character, `{a,b}` alternatives.
 * A `**` that forms a whole segment, at the start of the glob or of an alternative included, spans any number of segments.
 * The matcher runs every alternative at once instead of backtracking, so its time is linear in pattern size times subject size
 * and a hostile pattern or subject (a remote URL comes from the repository) cannot stall the guard.
 */
export function compileGlob(glob: string, ignoreCase = false): (subject: string) => boolean {
	const fold = (text: string) => (ignoreCase ? text.toLowerCase() : text);
	const program: Step[] = [];
	emit(parseGlob(fold(glob), true), program);
	program.push({ op: "match" });
	return (subject) => matches(program, fold(subject));
}

function parseGlob(glob: string, startsSegment: boolean): GlobNode[] {
	const nodes: GlobNode[] = [];
	for (let index = 0; index < glob.length; index++) {
		const char = glob.charAt(index);
		if (char === "*") {
			let end = index;
			while (glob[end] === "*") end++;
			const wholeSegmentBefore = index > 0 ? glob[index - 1] === "/" : startsSegment;
			if (end - index >= 2 && wholeSegmentBefore && glob[end] === "/") {
				nodes.push({ kind: "segments" });
				index = end;
			} else if (end - index >= 2 && wholeSegmentBefore && end === glob.length) {
				// The `/` before the `**` belongs to the optional tail.
				if (index > 0) nodes.pop();
				nodes.push({ kind: "below" });
				index = end - 1;
			} else {
				nodes.push({ kind: "run" });
				index = end - 1;
			}
		} else if (char === "?") {
			nodes.push({ kind: "one" });
		} else if (char === "{") {
			const close = matchingBrace(glob, index);
			if (close < 0) {
				nodes.push({ kind: "literal", char });
			} else {
				const alternativeStartsSegment = index > 0 ? glob[index - 1] === "/" : startsSegment;
				const alternatives = splitAlternatives(glob.slice(index + 1, close)).map((alternative) => parseGlob(alternative, alternativeStartsSegment));
				nodes.push({ kind: "group", alternatives });
				index = close;
			}
		} else {
			nodes.push({ kind: "literal", char });
		}
	}
	return nodes;
}

function emit(nodes: GlobNode[], program: Step[]): void {
	for (const node of nodes) {
		const at = program.length;
		switch (node.kind) {
			case "literal":
				program.push({ op: "char", char: node.char });
				break;
			case "one":
				program.push({ op: "not-slash" });
				break;
			case "run":
				program.push({ op: "split", first: at + 1, second: at + 3 }, { op: "not-slash" }, { op: "jump", to: at });
				break;
			case "segments":
				program.push(
					{ op: "split", first: at + 1, second: at + 5 },
					{ op: "not-slash" },
					{ op: "split", first: at + 1, second: at + 3 },
					{ op: "char", char: "/" },
					{ op: "jump", to: at },
				);
				break;
			case "below":
				program.push(
					{ op: "split", first: at + 1, second: at + 5 },
					{ op: "char", char: "/" },
					{ op: "split", first: at + 3, second: at + 5 },
					{ op: "any" },
					{ op: "jump", to: at + 2 },
				);
				break;
			case "group":
				emitGroup(node.alternatives, program);
				break;
		}
	}
}

function emitGroup(alternatives: GlobNode[][], program: Step[]): void {
	const exits: Array<Extract<Step, { op: "jump" }>> = [];
	alternatives.forEach((alternative, position) => {
		if (position === alternatives.length - 1) {
			emit(alternative, program);
			return;
		}
		const choice: Extract<Step, { op: "split" }> = { op: "split", first: program.length + 1, second: -1 };
		program.push(choice);
		emit(alternative, program);
		const exit: Extract<Step, { op: "jump" }> = { op: "jump", to: -1 };
		exits.push(exit);
		program.push(exit);
		choice.second = program.length;
	});
	for (const exit of exits) exit.to = program.length;
}

/** The step at `pc`; every pc a thread holds comes from the compiled program, so a missing step is a compiler bug. */
function stepAt(program: Step[], pc: number): Step {
	const step = program[pc];
	if (step === undefined) throw new Error(`glob program has no step ${pc}`);
	return step;
}

/** Runs every thread of the program over the subject, one character at a time. */
function matches(program: Step[], subject: string): boolean {
	let threads = follow(program, [0]);
	for (const char of subject) {
		const next: number[] = [];
		for (const pc of threads) {
			const step = stepAt(program, pc);
			if (step.op === "any" || (step.op === "not-slash" && char !== "/") || (step.op === "char" && step.char === char)) next.push(pc + 1);
		}
		if (next.length === 0) return false;
		threads = follow(program, next);
	}
	return threads.some((pc) => stepAt(program, pc).op === "match");
}

/** The consuming and matching steps reachable from the given ones through jumps and splits, each once. */
function follow(program: Step[], starts: number[]): number[] {
	const seen = new Set<number>();
	const reached: number[] = [];
	const pending = [...starts];
	while (pending.length > 0) {
		const pc = pending.pop();
		if (pc === undefined) break;
		if (seen.has(pc)) continue;
		seen.add(pc);
		const step = stepAt(program, pc);
		if (step.op === "jump") pending.push(step.to);
		else if (step.op === "split") pending.push(step.first, step.second);
		else reached.push(pc);
	}
	return reached;
}

function matchingBrace(glob: string, open: number): number {
	let depth = 0;
	for (let index = open; index < glob.length; index++) {
		if (glob[index] === "{") depth++;
		else if (glob[index] === "}" && --depth === 0) return index;
	}
	return -1;
}

function splitAlternatives(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < body.length; index++) {
		if (body[index] === "{") depth++;
		else if (body[index] === "}") depth--;
		else if (body[index] === "," && depth === 0) {
			parts.push(body.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}
