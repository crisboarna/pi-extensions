// Stand-ins for `#` autocomplete providers, written the way the design says the package's
// provider behaves (DESIGN.md section 4). They are probes: the assumption under test is pi's,
// not theirs.
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

const TOKEN = /(?:^|[ \t])#([^\s#]*)$/;

/** What an `addAutocompleteProvider` factory for the Trigger does: claim a bare `#` and any `#text` that some row matches. */
export function refsProvider(rows: string[]): (current: AutocompleteProvider) => AutocompleteProvider {
	return (current) => ({
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const token = TOKEN.exec((lines[cursorLine] ?? "").slice(0, cursorCol))?.[1];
			if (token === undefined || /^\d+$/.test(token)) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const matches = rows.filter((row) => row.toLowerCase().includes(token.toLowerCase()));
			if (matches.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items: matches.map((row): AutocompleteItem => ({ value: row, label: row, description: "probe ref" })), prefix: `#${token}` };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!item.value.startsWith("ref:")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			const start = cursorCol - prefix.length;
			const next = [...lines];
			next[cursorLine] = `${line.slice(0, start)}[${item.value}]${line.slice(cursorCol)}`;
			return { lines: next, cursorLine, cursorCol: start + item.value.length + 2 };
		},
	});
}

/** What another extension's `#` provider does, after pi's github-issue-autocomplete example: it answers numeric tokens. */
export function issuesProvider(issues: string[]): (current: AutocompleteProvider) => AutocompleteProvider {
	return (current) => ({
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const token = TOKEN.exec((lines[cursorLine] ?? "").slice(0, cursorCol))?.[1];
			const matches = token === undefined ? [] : issues.filter((issue) => issue.startsWith(`#${token}`));
			if (matches.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items: matches.map((issue): AutocompleteItem => ({ value: issue, label: issue, description: "probe issue" })), prefix: `#${token}` };
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
	});
}
