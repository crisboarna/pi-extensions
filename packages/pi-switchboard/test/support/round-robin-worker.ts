// Child process for the shared-pointer test: makes N round-robin picks
// against a shared health file and prints each chosen member.
import type { Tier } from "../../src/config/types.ts";
import { FileHealthStore } from "../../src/selection/health.ts";
import { selectMember } from "../../src/selection/select.ts";
import { seededRng } from "../../src/util/runtime.ts";

const [path, count] = process.argv.slice(2);
if (!path || !count) throw new Error("usage: round-robin-worker <health.json> <count>");

const tier: Tier = {
	name: "t",
	rank: 1,
	members: [
		{ key: "a/x", provider: "a", id: "x", weight: 1, enabled: true, tags: [], index: 0 },
		{ key: "b/y", provider: "b", id: "y", weight: 1, enabled: true, tags: [], index: 1 },
	],
	strategy: { name: "round-robin", granularity: "request", fallback: "ordered" },
	cooldown: { scope: "member" },
};

const store = new FileHealthStore(path);
const lines: string[] = [];
for (let i = 0; i < Number(count); i++) {
	const result = selectMember({ tier, tierKey: "p/t", store, now: Date.now(), rng: seededRng(i), task: i });
	if (!store.shared) throw new Error("lock not acquired");
	if (result.ok) lines.push(result.member.key);
}
process.stdout.write(`${lines.join("\n")}\n`);
