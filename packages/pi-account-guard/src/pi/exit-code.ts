let keptExitCode: number | undefined;

/**
 * Sets the process exit code and keeps it to the end. pi print mode sets exit code 1 after an aborted run and `main` assigns it
 * after the extensions have shut down, which would replace a Block exit code set while the run was aborted.
 */
export function keepExitCode(code: number): void {
	process.exitCode = code;
	if (keptExitCode === undefined) process.on("exit", () => void (process.exitCode = keptExitCode));
	keptExitCode = code;
}
