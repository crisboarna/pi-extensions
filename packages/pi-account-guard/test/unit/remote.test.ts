import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeRemoteUrl } from "../../src/core/remote.ts";

describe("normalizeRemoteUrl", () => {
	it("reduces every common URL form of one repository to host/path", () => {
		for (const url of [
			"git@github.com:Acme/api.git",
			"ssh://git@github.com/Acme/api.git",
			"https://github.com/Acme/api.git",
			"https://github.com/Acme/api",
			"https://github.com/Acme/api/",
			"https://user:secret@github.com/Acme/api.git",
			"git://github.com/Acme/api.git",
		]) {
			assert.equal(normalizeRemoteUrl(url), "github.com/Acme/api", url);
		}
	});

	it("keeps the host as written, including an ssh config alias", () => {
		assert.equal(normalizeRemoteUrl("git@github.com-acme:billing-portal/app.git"), "github.com-acme/billing-portal/app");
	});

	it("replaces the colon before a port with a slash", () => {
		assert.equal(normalizeRemoteUrl("ssh://git@git.example.com:2222/team/api.git"), "git.example.com/2222/team/api");
	});

	it("handles an scp-like URL with an absolute path", () => {
		assert.equal(normalizeRemoteUrl("git@git.example.com:/srv/git/api.git"), "git.example.com/srv/git/api");
	});

	it("percent-decodes the result", () => {
		assert.equal(normalizeRemoteUrl("https://github.com/Acme/my%20repo.git"), "github.com/Acme/my repo");
		assert.equal(normalizeRemoteUrl("https://github.com/Acme/100%.git"), "github.com/Acme/100%", "invalid escapes stay as written");
	});

	it("leaves a local path remote as a path", () => {
		assert.equal(normalizeRemoteUrl("/srv/git/api.git"), "/srv/git/api");
	});
});
