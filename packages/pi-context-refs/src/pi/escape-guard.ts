/**
 * Who else may need Esc while a send runs a command. The listener that cancels a send sees keys before the focused component, so without this
 * it would take the Esc that closes the autocomplete list or the overlay.
 */
export interface EscapeGuard {
	/** True while something else wants Esc: a component that was asked to `hold`, or a check from `watch` that says it is open. */
	taken(): boolean;
	/** Adds a check that is asked each time Esc is pressed. */
	watch(isOpen: () => boolean): void;
	/** Marks a component as open until the returned function is called. */
	hold(): () => void;
}

export function createEscapeGuard(): EscapeGuard {
	const checks: Array<() => boolean> = [];
	let held = 0;
	return {
		taken: () => held > 0 || checks.some((isOpen) => isOpen()),
		watch: (isOpen) => void checks.push(isOpen),
		hold: () => {
			held += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				held -= 1;
			};
		},
	};
}
