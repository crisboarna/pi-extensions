import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

test("the command shows the greeting for the working directory", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notices: string[] = [];
	const pi = { registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command) };
	extension(pi as unknown as ExtensionAPI);
	await commands.get("context-refs")?.handler("", { cwd: "/work", ui: { notify: (message: string) => notices.push(message) } });
	assert.deepEqual(notices, ["pi-context-refs is running in /work"]);
});
