import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GITHUB_REGISTRY, githubNpmrc, githubPackagesPlan } from "../scripts/release/github-packages.ts";

describe("publishing to GitHub Packages", () => {
	const workspaces = { "@crisboarna/pi-switchboard": "packages/pi-switchboard", "@crisboarna/pi-account-guard": "packages/pi-account-guard" };

	it("publishes each version Changesets published, from its workspace folder", () => {
		assert.deepEqual(githubPackagesPlan([{ name: "@crisboarna/pi-switchboard", version: "0.1.0" }], workspaces), [
			{ name: "@crisboarna/pi-switchboard", version: "0.1.0", folder: "packages/pi-switchboard" },
		]);
		assert.deepEqual(githubPackagesPlan([], workspaces), []);
	});

	it("refuses a package that is not in the repository", () => {
		assert.throws(() => githubPackagesPlan([{ name: "@other/thing", version: "1.0.0" }], workspaces), /@other\/thing is not a package of this repository/);
	});

	it("points the scope at GitHub Packages and reads the token from the environment when npm runs", () => {
		assert.equal(GITHUB_REGISTRY, "https://npm.pkg.github.com");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: npm expands ${GITHUB_TOKEN} itself; the file must not hold the token
		assert.equal(githubNpmrc("@crisboarna"), "@crisboarna:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n");
	});
});
