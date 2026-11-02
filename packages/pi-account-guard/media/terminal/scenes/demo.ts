// The hero demo: one pi session in a personal repository (dotfiles) that starts
// on the work account. Only the model replies are scripted; pi and the guard are real.
import type { LlmRequest } from "../../../../../tools/media/terminal-kit/fake-llm.ts";
import type { GuardScene } from "../setup.ts";

const reply = (request: LlmRequest) => {
	// A long answer streams slowly, so a model change lands while it runs.
	if (request.lastUser.includes("zshrc"))
		return {
			text: "Your .zshrc loads nvm eagerly, which costs about 400 ms on every start; load it lazily instead. compinit also runs twice, once in .zshrc and once in the oh-my-zsh plugin. ".repeat(
				5,
			),
			wordMs: 150,
		};
	if (request.lastUser.includes("alias")) return { text: "Added undo = reset --soft HEAD~1 to the [alias] section of .gitconfig.", wordMs: 30 };
	return { text: "install.sh links every file under home/ into ~, installs the Brewfile packages, and sets zsh as the login shell.", wordMs: 30 };
};

export const scene: GuardScene = { place: "personal", model: "openai/gpt-5.5", llm: reply };
