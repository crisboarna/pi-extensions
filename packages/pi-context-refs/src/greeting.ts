/** The message the command shows; kept apart from index.ts so tests can import it. */
export function greeting(cwd: string): string {
	return `pi-context-refs is running in ${cwd}`;
}
