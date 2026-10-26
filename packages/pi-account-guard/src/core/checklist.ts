export type ChecklistKey = "up" | "down" | "toggle" | "submit" | "cancel";

/** `done` holds the checked options in list order, or `undefined` when the user cancelled. */
export type ChecklistOutcome = { done: string[] | undefined };

export interface Checklist {
	/** The lines to draw. */
	lines(): string[];
	/** Applies a key. Returns an outcome once the list is submitted with something checked, or cancelled. */
	press(key: ChecklistKey): ChecklistOutcome | undefined;
}

const HINT = "up/down move, space checks, enter confirms, esc cancels";
const NOTHING_CHECKED = "Check at least one zone, or press esc to cancel.";

/** A checkbox list with nothing pre-checked (the TUI form of the Tag prompt, DESIGN.md section 10.1). Submitting with nothing checked asks again. */
export function createChecklist(title: string, options: string[]): Checklist {
	const checked = options.map(() => false);
	let cursor = 0;
	let complaint = false;
	return {
		lines() {
			const rows = options.map((option, index) => `${index === cursor ? ">" : " "} [${checked[index] ? "x" : " "}] ${option}`);
			return [title, "", ...rows, "", complaint ? NOTHING_CHECKED : HINT];
		},
		press(key) {
			complaint = false;
			switch (key) {
				case "up":
					cursor = Math.max(0, cursor - 1);
					return undefined;
				case "down":
					cursor = Math.min(options.length - 1, cursor + 1);
					return undefined;
				case "toggle":
					checked[cursor] = !checked[cursor];
					return undefined;
				case "cancel":
					return { done: undefined };
				case "submit": {
					const chosen = options.filter((_option, index) => checked[index]);
					if (chosen.length > 0) return { done: chosen };
					complaint = true;
					return undefined;
				}
			}
		},
	};
}
