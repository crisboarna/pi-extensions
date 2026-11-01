import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cachedRemoteReader } from "../../src/pi/git-remotes.ts";

describe("cachedRemoteReader", () => {
	const counting = () => {
		const asked: string[] = [];
		const read = (cwd: string) => {
			asked.push(cwd);
			return [`url-${asked.length}`];
		};
		return { asked, read };
	};

	it("asks git once for the same directory within the time to live, so the picker does not run git on each keystroke", () => {
		const { asked, read } = counting();
		let now = 0;
		const remotes = cachedRemoteReader(read, () => now, 5000);
		assert.deepEqual(remotes("/p"), ["url-1"]);
		now = 4999;
		assert.deepEqual(remotes("/p"), ["url-1"]);
		assert.deepEqual(asked, ["/p"]);
	});

	it("asks again after the time to live, so a remote added in the session is seen", () => {
		const { asked, read } = counting();
		let now = 0;
		const remotes = cachedRemoteReader(read, () => now, 5000);
		remotes("/p");
		now = 5000;
		assert.deepEqual(remotes("/p"), ["url-2"]);
		assert.equal(asked.length, 2);
	});

	it("keeps each directory apart", () => {
		const { asked, read } = counting();
		const remotes = cachedRemoteReader(read, () => 0, 5000);
		remotes("/a");
		remotes("/b");
		assert.deepEqual(asked, ["/a", "/b"]);
	});

	it("caches that git could not answer as well", () => {
		let calls = 0;
		const remotes = cachedRemoteReader(
			() => {
				calls++;
				return undefined;
			},
			() => 0,
			5000,
		);
		assert.equal(remotes("/p"), undefined);
		assert.equal(remotes("/p"), undefined);
		assert.equal(calls, 1);
	});
});
