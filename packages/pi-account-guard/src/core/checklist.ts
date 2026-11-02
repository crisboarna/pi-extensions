export type ChecklistKey = "up" | "down" | "toggle" | "submit" | "cancel";

/** `done` holds the checked options in list order, or `undefined` when the user cancelled. */
type ChecklistOutcome = { done: string[] | undefined };

export interface Checklist {
	/** The lines to draw. With a `limit`, a list too long for it shows a window around the cursor and says how many options are above and below. */
	lines(limit?: number): string[];
	/** Applies a key. Returns an outcome once the list is submitted with something checked, or cancelled. */
	press(key: ChecklistKey): ChecklistOutcome | undefined;
}

const HINT = "up/down move, space checks, enter confirms, esc cancels";
const NOTHING_CHECKED = "Check at least one zone, or press esc to cancel.";
/** The title, the blank line after it, the blank line before the hint, and the hint. */
const FRAME_LINES = 4;

/** A checkbox list with nothing pre-checked (the TUI form of the Tag prompt, DESIGN.md section 10.1). Submitting with nothing checked asks again. */
export function createChecklist(title: string, options: string[]): Checklist {
	const checked = options.map(() => false);
	let cursor = 0;
	let complaint = false;
	return {
		lines(limit = Number.POSITIVE_INFINITY) {
			const rows = options.map((option, index) => `${index === cursor ? ">" : " "} [${checked[index] ? "x" : " "}] ${option}`);
			let shown = rows;
			if (rows.length > limit - FRAME_LINES) {
				// the two lines for "N more" take room from the options, and at least the cursor's option stays
				const size = Math.max(1, limit - FRAME_LINES - 2);
				const from = Math.min(Math.max(0, cursor - Math.floor(size / 2)), rows.length - size);
				const to = from + size;
				shown = [...(from > 0 ? [`  ↑ ${from} more`] : []), ...rows.slice(from, to), ...(to < rows.length ? [`  ↓ ${rows.length - to} more`] : [])];
			}
			return [title, "", ...shown, "", complaint ? NOTHING_CHECKED : HINT];
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
