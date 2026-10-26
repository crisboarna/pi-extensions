// The hero demo: one pi session in a personal repository that starts on the
// work account. Only the model replies are scripted; pi and the guard are real.
import type { LlmRequest } from "../../../../../tools/media/terminal-kit/fake-llm.ts";
import type { GuardScene } from "../setup.ts";

const reply = (request: LlmRequest) => {
	// A long answer streams slowly, so a model change lands while it runs.
	if (request.lastUser.includes("planting plan"))
		return {
			text: "Here is a planting plan for the spring: the tomatoes go in bed 2 after the last frost, the beans climb the north fence, and the herbs share bed 4. ".repeat(
				5,
			),
			wordMs: 150,
		};
	if (request.lastUser.includes("watering"))
		return { text: "Beds 1 and 3 dry out first: water them every second morning, and the shaded bed 4 twice a week.", wordMs: 30 };
	return { text: "Four beds: tomatoes and basil in bed 2, beans along the fence, herbs in the shade of bed 4, and bed 1 resting under clover.", wordMs: 30 };
};

export const scene: GuardScene = { place: "personal", model: "acme/work-model", llm: reply };
