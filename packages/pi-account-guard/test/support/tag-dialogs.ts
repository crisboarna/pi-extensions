// Scripted `input` and `custom` dialogs and the run mode of a fake session, for the tag prompt.
import type { FakeSession } from "./fake-pi.ts";

export const KEY = { down: "\x1b[B", up: "\x1b[A", space: " ", enter: "\r", escape: "\x1b" } as const;

export interface TagDialogs {
	inputs: Array<{ title: string; placeholder?: string }>;
	/** Answers to `input`, consumed in order; `undefined` is a closed dialog. */
	inputAnswers: Array<string | undefined>;
	/** One list of key presses per `custom` dialog, consumed in order; a dialog still open after its keys resolves as cancelled. */
	customKeys: string[][];
	/** Every frame a `custom` dialog drew, per dialog: the first render and one per key that did not close it. */
	customFrames: string[][][];
}

export function attachTagDialogs(session: FakeSession, mode: "tui" | "rpc" | "print" | "json"): TagDialogs {
	const dialogs: TagDialogs = { inputs: [], inputAnswers: [], customKeys: [], customFrames: [] };
	const { ctx } = session;
	ctx.mode = mode;
	ctx.ui.input = async (title: string, placeholder?: string) => {
		dialogs.inputs.push({ title, ...(placeholder === undefined ? {} : { placeholder }) });
		return dialogs.inputAnswers.shift();
	};
	ctx.ui.custom = async (factory: (...args: any[]) => any) => {
		let result: unknown;
		let closed = false;
		const tui = { requestRender: () => undefined };
		const component = await factory(tui, {}, {}, (value: unknown) => {
			result = value;
			closed = true;
		});
		const frames: string[][] = [component.render(80)];
		dialogs.customFrames.push(frames);
		for (const key of dialogs.customKeys.shift() ?? []) {
			if (closed) break;
			component.handleInput(key);
			if (!closed) frames.push(component.render(80));
		}
		return result;
	};
	return dialogs;
}
