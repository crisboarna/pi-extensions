import { createHash } from "node:crypto";

/** Our namespace inside pi-subagents' `extensionBindings`. */
export const BINDING_NAMESPACE = "pi-switchboard/1";
const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
/** pi-subagents allows 256 properties in all bindings; leave room for other extensions. */
const MAX_LAUNCHES = 48;

/** One launch of a `subagent` call: which decision it came from. */
export interface LaunchLink {
	/** Digest of agent and task text. */
	d: string;
	/** Agent name. */
	a: string;
	/** Launch decision id. */
	id: string;
}

export interface SwitchboardBinding {
	parent: string;
	launches: LaunchLink[];
}

/** Short digest of an agent and its task; the child computes the same from its first message. */
export function taskDigest(agent: string, task: string): string {
	return createHash("sha256").update(`${agent}\n${task.trim()}`).digest("hex").slice(0, 16);
}

/**
 * Adds our binding to a `subagent` call's `options.extensionBindings`,
 * keeping bindings other extensions set. One binding covers every task of a
 * parallel call, so launches are keyed by agent and task digest.
 */
export function attachBinding(input: Record<string, unknown>, binding: SwitchboardBinding): boolean {
	if (binding.launches.length === 0) return false;
	const options = (typeof input.options === "object" && input.options !== null && !Array.isArray(input.options) ? input.options : (input.options = {})) as Record<string, unknown>;
	const existing = options.extensionBindings ?? input.extensionBindings;
	const bindings = typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
	bindings[BINDING_NAMESPACE] = { parent: binding.parent, launches: binding.launches.slice(0, MAX_LAUNCHES) };
	options.extensionBindings = bindings;
	if ("extensionBindings" in input) delete input.extensionBindings;
	return true;
}

/** Our binding from the child's environment, if pi-subagents passed one. */
export function readBinding(env: NodeJS.ProcessEnv = process.env): SwitchboardBinding | undefined {
	const raw = env[BINDINGS_ENV];
	if (!raw) return undefined;
	try {
		const value = (JSON.parse(raw) as Record<string, unknown>)[BINDING_NAMESPACE] as SwitchboardBinding | undefined;
		if (!value || typeof value.parent !== "string" || !Array.isArray(value.launches)) return undefined;
		return { parent: value.parent, launches: value.launches.filter((l) => typeof l?.id === "string" && typeof l.d === "string" && typeof l.a === "string") };
	} catch {
		return undefined;
	}
}

/**
 * The launch decision a child belongs to: by agent and task digest, else the
 * only launch of its agent, else the only launch of the call.
 */
export function matchLaunch(binding: SwitchboardBinding, agent: string | undefined, task: string): string | undefined {
	if (agent) {
		const digest = taskDigest(agent, task);
		const exact = binding.launches.find((l) => l.d === digest);
		if (exact) return exact.id;
		const sameAgent = binding.launches.filter((l) => l.a === agent);
		if (sameAgent.length === 1) return sameAgent[0]?.id;
	}
	return binding.launches.length === 1 ? binding.launches[0]?.id : undefined;
}
