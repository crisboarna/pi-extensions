// The README and docs clips: one scene per clip, demo accounts and repositories only.
import type { LlmRequest } from "../../../../../tools/media/terminal-kit/fake-llm.ts";
import type { GuardScene } from "../setup.ts";

export const reply = (request: LlmRequest) => {
	// A long answer streams slowly, so a model change lands while it runs.
	if (request.lastUser.includes("zshrc"))
		return {
			text: "Your .zshrc loads nvm eagerly, which costs about 400 ms on every start; load it lazily instead. compinit also runs twice, once in .zshrc and once in the oh-my-zsh plugin. ".repeat(
				5,
			),
			wordMs: 150,
		};
	if (request.lastUser.includes("alias")) return { text: "Added undo = reset --soft HEAD~1 to the [alias] section of .gitconfig.", wordMs: 30 };
	if (request.lastUser.includes("invoice")) return { text: "The invoice total now rounds each line before summing.", wordMs: 30 };
	if (request.lastUser.includes("health")) return { text: "Added GET /health returning the build version.", wordMs: 30 };
	return { text: "install.sh links every file under home/ into ~, installs the Brewfile packages, and sets zsh as the login shell.", wordMs: 30 };
};

export const blockScene: GuardScene = { place: "personal", model: "openai/gpt-5.5", llm: reply };
export const tagScene: GuardScene = { place: "personal", model: "google/gemini-3.8-flash", llm: reply };
export const midTurnScene: GuardScene = { place: "personal", model: "anthropic/claude-sonnet-5", llm: reply };
export const workScene: GuardScene = { place: "work", model: "openai/gpt-5.5", llm: reply };
export const clientScene: GuardScene = { place: "client", model: "openai/gpt-5.5", llm: reply };
export const headlessScene: GuardScene = { place: "personal", model: "openai/gpt-5.5", shell: true, llm: reply };
export const switchboardScene: GuardScene = { place: "personal", model: "switchboard/auto", with: ["switchboard"], llm: reply };
