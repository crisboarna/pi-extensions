// The README and docs clips: one scene per clip, demo accounts and repositories only.
import type { LlmRequest } from "../../../../../tools/media/terminal-kit/fake-llm.ts";
import type { GuardScene } from "../setup.ts";

export const reply = (request: LlmRequest) => {
	// A long answer streams slowly, so a model change lands while it runs.
	if (request.lastUser.includes("planting plan"))
		return {
			text: "Here is a planting plan for the spring: the tomatoes go in bed 2 after the last frost, the beans climb the north fence, and the herbs share bed 4. ".repeat(
				5,
			),
			wordMs: 150,
		};
	if (request.lastUser.includes("invoice")) return { text: "The invoice total now rounds each line before summing.", wordMs: 30 };
	if (request.lastUser.includes("health")) return { text: "Added GET /health returning the build version.", wordMs: 30 };
	return { text: "Four beds: tomatoes and basil in bed 2, beans along the fence, herbs in bed 4, and bed 1 resting.", wordMs: 30 };
};

export const blockScene: GuardScene = { place: "personal", model: "acme/work-model", llm: reply };
export const tagScene: GuardScene = { place: "personal", model: "spare/spare-model", llm: reply };
export const midTurnScene: GuardScene = { place: "personal", model: "homelab/home-model", llm: reply };
export const workScene: GuardScene = { place: "work", model: "acme/work-model", llm: reply };
export const clientScene: GuardScene = { place: "client", model: "acme/work-model", llm: reply };
export const headlessScene: GuardScene = { place: "personal", model: "acme/work-model", shell: true, llm: reply };
export const switchboardScene: GuardScene = { place: "personal", model: "switchboard/auto", with: ["switchboard"], llm: reply };
