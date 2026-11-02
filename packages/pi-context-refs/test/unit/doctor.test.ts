// `/ref doctor` turns facts about the libraries, the approvals file, git, the editor and the trigger into lines a person can act on. The
// formatting is pure, so every case is checked here without a machine behind it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DoctorFacts, doctorLines } from "../../src/core/doctor.ts";

const HEALTHY: DoctorFacts = {
	global: { path: "/agent/pi-context-refs.json", exists: true, refs: 3, warnings: [] },
	project: { trusted: true, path: "/work/.pi/pi-context-refs.json", exists: true, refs: 2, warnings: [] },
	approvals: { path: "/agent/pi-context-refs-approvals.json", count: 1 },
	pending: [],
	git: { inWorkTree: true, builtinsOff: [] },
	editor: "atomic",
	trigger: { configured: "#", session: "#", problems: [] },
	versions: { pi: "1.4.0", node: "v24.0.0", ui: true },
};

const lines = (change: Partial<DoctorFacts>) => doctorLines({ ...HEALTHY, ...change });
const text = (change: Partial<DoctorFacts>) => lines(change).join("\n");

describe("doctorLines", () => {
	it("says everything looks right when nothing is wrong, with one line per check", () => {
		const out = doctorLines(HEALTHY);
		assert.equal(out[0], "pi-context-refs doctor: everything looks right");
		assert.ok(
			out.slice(1).every((line) => line.startsWith("✓ ")),
			out.join("\n"),
		);
		assert.match(out.join("\n"), /✓ Global library: 3 refs in \/agent\/pi-context-refs\.json/);
		assert.match(out.join("\n"), /✓ Project library: 2 refs in \/work\/\.pi\/pi-context-refs\.json/);
		assert.match(out.join("\n"), /✓ approvals: 1 for this project/);
		assert.match(out.join("\n"), /✓ git: #diff, #staged, #status and #log work here/);
		assert.match(out.join("\n"), /✓ editor: a placeholder is one unit; one Backspace deletes it/);
		assert.match(out.join("\n"), /✓ trigger: # opens the list; alt\+r always opens the overlay/);
		assert.match(out.join("\n"), /✓ pi 1\.4\.0, Node v24\.0\.0, with a UI/);
	});

	it("puts problems first, then warnings, then what is fine, and counts them", () => {
		const out = lines({
			global: { path: "/g.json", exists: true, refs: 0, warnings: [], error: "/g.json is not valid JSON" },
			editor: "plain:replaced",
		});
		assert.equal(out[0], "pi-context-refs doctor: 1 problem(s), 1 warning(s)");
		assert.match(out[1] ?? "", /^✗ /);
		assert.match(out[2] ?? "", /^! /);
		assert.ok(out.slice(3).every((line) => line.startsWith("✓ ")));
	});

	describe("the libraries", () => {
		it("says a missing Global library is fine and how to make one", () => {
			assert.match(
				text({ global: { path: "/g.json", exists: false, refs: 0, warnings: [] } }),
				/✓ Global library: none yet \(\/g\.json\); \/ref add creates it/,
			);
		});

		it("names a library that cannot be used, with the reason", () => {
			const out = text({ global: { path: "/g.json", exists: true, refs: 0, warnings: [], error: "/g.json: unexpected token at line 3" } });
			assert.match(out, /✗ Global library: \/g\.json: unexpected token at line 3/);
		});

		it("shows each warning the library reported", () => {
			const out = text({ global: { path: "/g.json", exists: true, refs: 2, warnings: ["refs[1].name: duplicate of refs[0]"] } });
			assert.match(out, /! Global library: refs\[1\]\.name: duplicate of refs\[0\]/);
			assert.match(out, /✓ Global library: 2 refs/);
		});

		it("says a Project library is not loaded when pi does not trust the project, and what to do", () => {
			const out = text({ project: { trusted: false, path: "/work/.pi/pi-context-refs.json", exists: true } });
			assert.match(
				out,
				/! Project library: \/work\/\.pi\/pi-context-refs\.json is not loaded because pi does not trust this project; run \/trust, then restart pi/,
			);
		});

		it("says nothing alarming about an untrusted project that has no library", () => {
			const out = text({ project: { trusted: false, path: "/work/.pi/pi-context-refs.json", exists: false } });
			assert.match(out, /✓ Project library: none/);
			assert.doesNotMatch(out, /\/trust/);
		});

		it("names a Project library that cannot be used", () => {
			const out = text({ project: { trusted: true, path: "/p.json", exists: true, refs: 0, warnings: [], error: "/p.json has version 2" } });
			assert.match(out, /✗ Project library: \/p\.json has version 2/);
		});

		it("says a trusted project with no library is fine", () => {
			assert.match(text({ project: { trusted: true, path: "/p.json", exists: false, refs: 0, warnings: [] } }), /✓ Project library: none \(\/p\.json\)/);
		});
	});

	describe("the approvals", () => {
		it("names an approvals file that cannot be read, and what is lost", () => {
			const out = text({ approvals: { path: "/a.json", count: 0, error: "/a.json is not valid JSON" } });
			assert.match(out, /✗ approvals: \/a\.json is not valid JSON; every Project command asks again until it is fixed or removed/);
		});

		it("lists the Project commands that wait for an Approval and how to give one", () => {
			const out = text({ pending: ["setup", "fetch-docs"] });
			assert.match(
				out,
				/! 2 Project refs wait for an Approval: setup, fetch-docs; send a message that names one from the TUI, or run \/ref approve <name>/,
			);
		});

		it("says a single waiting ref in the singular", () => {
			assert.match(text({ pending: ["setup"] }), /! 1 Project ref waits for an Approval: setup;/);
		});
	});

	describe("git", () => {
		it("says the built-in refs are hidden outside a git work tree", () => {
			assert.match(
				text({ git: { inWorkTree: false, builtinsOff: [] } }),
				/! git: this directory is not inside a git work tree, so #diff, #staged, #status and #log are hidden/,
			);
		});

		it("says which built-in refs the setting turns off", () => {
			const out = text({ git: { inWorkTree: true, builtinsOff: ["diff", "log"] } });
			assert.match(out, /✓ git: #staged and #status work here; #diff and #log are turned off by the builtins setting/);
		});

		it("says when the setting turns every built-in ref off", () => {
			const out = text({ git: { inWorkTree: true, builtinsOff: ["diff", "staged", "status", "log"] } });
			assert.match(out, /✓ git: every built-in ref is turned off by the builtins setting/);
		});
	});

	describe("the editor", () => {
		const editor = (status: DoctorFacts["editor"], ui = true) => text({ editor: status, versions: { pi: "1.4.0", node: "v24.0.0", ui } });

		it("says there is no editor without a UI, and that typed refs still expand", () => {
			assert.match(editor("no-ui", false), /✓ editor: this mode has no editor; typed refs still expand/);
		});

		it("says to look again while the editor is not wrapped yet", () => {
			assert.match(editor("pending"), /! editor: not wrapped yet; it is wrapped one tick after the session starts, so run \/ref doctor again/);
		});

		it("explains a pi whose editor has no segment method, and that the text still expands", () => {
			assert.match(
				editor("plain:no-segment"),
				/! editor: this pi's editor has no segment method, so a placeholder is plain text; it still expands when you send \(ADR 0001\)/,
			);
		});

		it("explains an editor another extension replaced, and that the text still expands", () => {
			assert.match(
				editor("plain:replaced"),
				/! editor: another extension replaced it after the wrap, so Backspace deletes one character; the placeholder still expands \(ADR 0007\)/,
			);
		});
	});

	describe("the trigger", () => {
		it("says what to do when the file and the session disagree", () => {
			assert.match(
				text({ trigger: { configured: "!", session: "#", problems: [] } }),
				/! trigger: the file says "!" but this session started with "#"; run \/reload/,
			);
		});

		it("shows a setting the package cannot use", () => {
			const out = text({ trigger: { configured: "#", session: "#", problems: ['trigger "/": reserved; using "#"'] } });
			assert.match(out, /! trigger: trigger "\/": reserved; using "#"/);
		});

		it("says a key another extension owns cannot be detected, and what to do", () => {
			assert.match(text({}), /if # opens nothing, another extension may own the key: set trigger to another character and run \/reload/);
		});
	});
});
