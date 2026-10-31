// The hero demo: one pi session in a small git repository with an uncommitted
// change. Only the model replies are scripted; pi and pi-context-refs are real.
//
// Called by: media/terminal/setup.ts (scene "demo"), media/manifest.json.
import type { LlmRequest } from "../../../../../tools/media/terminal-kit/fake-llm.ts";
import type { RefsScene } from "../setup.ts";

export const reply = (request: LlmRequest) => {
	if (request.lastUser.includes("Review"))
		return { text: "The change waits between attempts and caps the wait at one second. It reads well; add a test for the cap.", wordMs: 30 };
	if (request.lastUser.includes("retry"))
		return { text: "getOrder and payOrder both wrap their call in retry() with times set to 2, so a failing call runs three times in all.", wordMs: 30 };
	return { text: "Done.", wordMs: 30 };
};

export const scene: RefsScene = { library: false, llm: reply };
