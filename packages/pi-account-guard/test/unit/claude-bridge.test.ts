import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeBridgeSource, definesApiKeyHelper } from "../../src/core/claude-bridge.ts";

const HOME = "/home/me";

function source(env: Record<string, string | undefined>, usesApiKeyHelper: (directory: string) => boolean = () => false): string {
	return claudeBridgeSource({ env, home: HOME, usesApiKeyHelper });
}

describe("claudeBridgeSource", () => {
	it("resolves a work and a personal config directory to different sources", () => {
		const work = source({ CLAUDE_CONFIG_DIR: "/home/me/.claude-work" });
		const personal = source({ CLAUDE_CONFIG_DIR: "/home/me/.claude-personal" });
		assert.equal(work, "claude-config:~/.claude-work");
		assert.equal(personal, "claude-config:~/.claude-personal");
	});

	it("falls back to ~/.claude without CLAUDE_CONFIG_DIR, and treats an empty value as unset", () => {
		assert.equal(source({}), "claude-config:~/.claude");
		assert.equal(source({ CLAUDE_CONFIG_DIR: "" }), "claude-config:~/.claude");
	});

	it("gives the same source to one directory written in different forms", () => {
		assert.equal(source({ CLAUDE_CONFIG_DIR: "~/.claude" }), source({}));
		assert.equal(source({ CLAUDE_CONFIG_DIR: "/home/me/.claude/" }), source({}));
		assert.equal(source({ CLAUDE_CONFIG_DIR: "/home/me/x/../.claude" }), source({}));
	});

	it("shows a config directory outside the home directory as an absolute path", () => {
		assert.equal(source({ CLAUDE_CONFIG_DIR: "/srv/claude" }), "claude-config:/srv/claude");
	});

	it("names an environment credential by its variable and ignores the config directory", () => {
		assert.equal(source({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/srv/claude" }), "env:ANTHROPIC_API_KEY");
		assert.equal(source({ ANTHROPIC_AUTH_TOKEN: "t" }), "env:ANTHROPIC_AUTH_TOKEN");
		assert.equal(source({ CLAUDE_CODE_OAUTH_TOKEN: "o" }), "env:CLAUDE_CODE_OAUTH_TOKEN");
	});

	it("takes ANTHROPIC_AUTH_TOKEN before the other credentials when several are set", () => {
		assert.equal(source({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }), "env:ANTHROPIC_AUTH_TOKEN");
		assert.equal(source({ CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_API_KEY: "k" }), "env:CLAUDE_CODE_OAUTH_TOKEN");
	});

	it("ignores an empty credential variable", () => {
		assert.equal(source({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: undefined }), "claude-config:~/.claude");
	});

	it("maps each cloud provider switch to the generic claude-code source, ahead of every credential", () => {
		for (const name of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_VERTEX"]) {
			assert.equal(source({ [name]: "1", ANTHROPIC_API_KEY: "k" }), "claude-code", name);
		}
		assert.equal(source({ CLAUDE_CODE_USE_VERTEX: "true", CLAUDE_CONFIG_DIR: "/srv/claude" }), "claude-code");
	});

	it("does not treat a switched-off cloud provider variable as set", () => {
		assert.equal(source({ CLAUDE_CODE_USE_BEDROCK: "0", ANTHROPIC_API_KEY: "k" }), "env:ANTHROPIC_API_KEY");
		assert.equal(source({ CLAUDE_CODE_USE_BEDROCK: "false" }), "claude-config:~/.claude");
	});

	it("maps an apiKeyHelper setup to claude-code after the environment credentials", () => {
		const asked: string[] = [];
		const helper = (directory: string) => (asked.push(directory), true);
		assert.equal(source({ CLAUDE_CONFIG_DIR: "/srv/claude" }, helper), "claude-code");
		assert.deepEqual(asked, ["/srv/claude"]);
		assert.equal(source({ ANTHROPIC_API_KEY: "k" }, helper), "env:ANTHROPIC_API_KEY");
	});
});

describe("definesApiKeyHelper", () => {
	it("is true for a non-empty apiKeyHelper string", () => {
		assert.equal(definesApiKeyHelper('{"apiKeyHelper":"/bin/get-key"}'), true);
	});

	it("is false for a missing file, an empty value, another type, other keys and malformed text", () => {
		assert.equal(definesApiKeyHelper(undefined), false);
		assert.equal(definesApiKeyHelper('{"apiKeyHelper":""}'), false);
		assert.equal(definesApiKeyHelper('{"apiKeyHelper":true}'), false);
		assert.equal(definesApiKeyHelper('{"model":"x"}'), false);
		assert.equal(definesApiKeyHelper("{not json"), false);
		assert.equal(definesApiKeyHelper("null"), false);
	});
});
