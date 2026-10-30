const PI_KEYS = new Set(["/", "@", "!"]);

// A Trigger starts a ref unless a word, URL or path character comes before it, as for a typed `#name` (tokens.ts).
const BEFORE_A_WORD = /[\p{L}\p{N}._\-/\\#&=?]/u;

/** Why `value` cannot be the Trigger, or undefined when it can. Pi uses `/`, `@` and `!` for commands, files and bash, and drops whitespace as a trigger character. */
export function triggerProblem(value: string): string | undefined {
	if (value.length !== 1) return "the Trigger is one character";
	if (/\s/u.test(value)) return "the Trigger cannot be whitespace";
	if (PI_KEYS.has(value)) return `the Trigger cannot be "${value}", which pi uses itself`;
	return undefined;
}

/**
 * The text typed after the Trigger when the cursor sits at the end of a Trigger token in `beforeCursor`, or undefined when it does not.
 * The token starts at the beginning of the line or after a character that cannot belong to a word, URL or path, and a space ends it:
 * a bare Trigger gives `""`, `#ap` gives `"ap"`, `# heading` and `page#api` give undefined.
 */
export function triggerQuery(beforeCursor: string, trigger: string): string | undefined {
	const start = beforeCursor.lastIndexOf(trigger);
	if (start < 0) return undefined;
	const query = beforeCursor.slice(start + trigger.length);
	if (/\s/u.test(query)) return undefined;
	const before = [...beforeCursor.slice(0, start)].at(-1);
	if (before !== undefined && (before === trigger || BEFORE_A_WORD.test(before))) return undefined;
	return query;
}
