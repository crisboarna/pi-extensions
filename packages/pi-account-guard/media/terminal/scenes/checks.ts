// The manual checklist (docs/manual-checklist.md) run as scenes: demo
// accounts and repositories only. One scene per item; the page holds the steps.
import type { LlmRequest } from "../../../../../tools/media/terminal-kit/fake-llm.ts";
import type { GuardScene } from "../setup.ts";

const reply = (request: LlmRequest) => {
	// A long answer streams slowly, so a model change can land while it runs.
	if (request.lastUser.includes("long plan"))
		return {
			text: "Here is a long plan for the garden beds, step by step, with watering, soil, light and spacing for every bed in turn. ".repeat(6),
			wordMs: 140,
		};
	return { text: `Done on ${request.provider}/${request.model}.`, wordMs: 25 };
};

export const blockScene: GuardScene = { place: "personal", model: "acme/work-model", llm: reply };
export const tagScene: GuardScene = { place: "personal", model: "spare/spare-model", llm: reply };
export const midTurnScene: GuardScene = { place: "personal", model: "homelab/home-model", llm: reply };
const powerline = (customItems: unknown[]): GuardScene => ({
	place: "personal",
	model: "homelab/home-model",
	with: ["powerline"],
	settings: { powerline: { customItems } },
	llm: reply,
});
export const footerAbsentScene = powerline([]);
export const footerPlacedScene = powerline([{ id: "guard", statusKey: "guard", position: "left" }]);
export const switchboardWorkScene: GuardScene = { place: "work", model: "switchboard/auto", with: ["switchboard"], llm: reply };
export const switchboardPersonalScene: GuardScene = { place: "personal", model: "switchboard/auto", with: ["switchboard"], llm: reply };
