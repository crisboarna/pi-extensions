/** Exit code of a headless Block (ADR 0005). */
export const BLOCK_EXIT_CODE = 77;

/** The part of `process` the keeper uses; tests pass a fake. */
export interface ExitTarget {
	exitCode: string | number | null | undefined;
	on(event: "exit", listener: () => void): void;
}

/**
 * Returns a function that sets the process exit code and keeps it to the end. pi print mode sets exit code 1 after an aborted run and `main` assigns it
 * after the extensions have shut down, which would replace a Block exit code set while the run was aborted.
 * Each keeper holds its own code and listens only once it was asked to keep one, so two registrations in one process do not share state.
 */
export function createExitCodeKeeper(target: ExitTarget = process): (code: number) => void {
	let kept: number | undefined;
	return (code) => {
		target.exitCode = code;
		if (kept === undefined)
			target.on("exit", () => {
				target.exitCode = kept;
			});
		kept = code;
	};
}
