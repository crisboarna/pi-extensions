// Scripted dialogs, a model registry and `setModel` for a fake session, so an
// integration test can drive the Block select, the Allow once confirm and a Switch.
import type { FakeHost, FakeSession } from "./fake-pi.ts";

export interface FakeModel {
	provider: string;
	id: string;
	/** Auth the registry reports for the provider; defaults to a stored key. */
	/** The provider is lifted by pi-multiprovider: the registry returns it with the private pool marker. */
	pooled?: boolean;
	auth?: { usingOAuth?: boolean; status: { configured: boolean; source?: string; label?: string } };
}

/** An answer to a select: a regexp tested against the options, or `undefined` for no answer (Cancel). */
export type SelectAnswer = RegExp | undefined;

export interface Dialogs {
	selects: Array<{ title: string; options: string[] }>;
	confirms: Array<{ title: string; message: string }>;
	selectAnswers: SelectAnswer[];
	confirmAnswers: Array<boolean | undefined>;
	/** `provider/id` of every model passed to `setModel`. */
	modelChanges: string[];
	/** The pi API object to hand to `registerGuard`. */
	pi: Record<string, unknown>;
}

/** Replaces the session's select, confirm and registry; answers are consumed in order. */
export function attachDialogs(host: FakeHost, session: FakeSession, models: FakeModel[]): Dialogs {
	const dialogs: Dialogs = { selects: [], confirms: [], selectAnswers: [], confirmAnswers: [], modelChanges: [], pi: {} };
	const { ctx } = session;
	const authOf = (provider: string) => models.find((model) => model.provider === provider)?.auth;
	const registry = ctx.modelRegistry;
	ctx.modelRegistry = {
		...registry,
		isUsingOAuth: (model: FakeModel) => authOf(model.provider)?.usingOAuth ?? false,
		getProviderAuthStatus: (provider: string) => authOf(provider)?.status ?? { configured: true, source: "stored" },
		getAvailable: () => models,
		getAll: () => models,
		getProvider: (provider: string) =>
			models.some((model) => model.provider === provider && model.pooled) ? { [Symbol.for("pi-multiprovider.lifted-base")]: {} } : {},
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
	};
	ctx.ui.select = async (title: string, options: string[]) => {
		dialogs.selects.push({ title, options });
		const answer = dialogs.selectAnswers.shift();
		return answer === undefined ? undefined : options.find((option) => answer.test(option));
	};
	ctx.ui.confirm = async (title: string, message: string) => {
		dialogs.confirms.push({ title, message });
		return dialogs.confirmAnswers.shift() ?? false;
	};
	dialogs.pi = {
		on: host.pi.on,
		registerCommand: host.pi.registerCommand,
		appendEntry: host.pi.appendEntry,
		setModel: async (model: FakeModel) => {
			dialogs.modelChanges.push(`${model.provider}/${model.id}`);
			ctx.model = model;
			return true;
		},
	};
	return dialogs;
}
