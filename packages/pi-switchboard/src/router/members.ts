import type { Config, Profile } from "../config/types.ts";
import { accountSiblings, type Subscription } from "../selection/accounts.ts";

/**
 * The event-bus channel on which pi-switchboard lists the physical models behind one of its virtual models (ADR 0004), so
 * pi-account-guard can check each one's account. Another extension emits `{ provider, id, respond }`; pi's bus calls this
 * handler during `emit`, so the answer is given at once: `{ members }`, or `{ error }` when they cannot be listed.
 */
export const MEMBERS_CHANNEL = "switchboard:members:v1";

export interface MemberModel {
	provider: string;
	id: string;
}

/**
 * Every physical model the virtual model `virtualId` can route to: each enabled member of its profile (of every profile for
 * the auto model, which picks one per turn), across all tiers since a turn may borrow another, and the account siblings that
 * failover or subagent account affinity may move a member to. `undefined` when `virtualId` is not one of this config's models.
 */
export function routableMembers(
	config: Config,
	virtualId: string,
	subscriptions: readonly Subscription[],
	isProvider: (name: string) => boolean,
): MemberModel[] | undefined {
	const profiles = profilesOf(config, virtualId);
	if (!profiles) return undefined;
	const siblings = config.failover.accountSiblings === "on" || config.subagents.accountAffinity === "parent";
	const seen = new Map<string, MemberModel>();
	const add = (provider: string, id: string) => {
		const key = `${provider}/${id}`;
		if (!seen.has(key)) seen.set(key, { provider, id });
	};
	for (const profile of profiles)
		for (const tier of profile.tiers)
			for (const member of tier.members) {
				if (!member.enabled) continue;
				add(member.provider, member.id);
				if (siblings) for (const sibling of accountSiblings(member.provider, subscriptions, isProvider)) add(sibling, member.id);
			}
	return [...seen.values()];
}

/** The profiles a virtual model routes within: all of them for the auto model, else its own; `undefined` when the id is not one. */
function profilesOf(config: Config, virtualId: string): Profile[] | undefined {
	if (virtualId === config.virtualModel.id) return Object.values(config.profiles);
	const profile = config.profiles[virtualId.split(".")[0] ?? ""];
	return profile && isOwnId(profile, virtualId) ? [profile] : undefined;
}

/** `<profile>` or `<profile>.<tier>`, as `virtualModelIds` registers them. */
function isOwnId(profile: Profile, virtualId: string): boolean {
	if (virtualId === profile.name) return true;
	return profile.tiers.some((tier) => virtualId === `${profile.name}.${tier.name}`);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Answers a members request for one of this extension's virtual models, and stays silent for any other model. A failure to
 * list them is answered as `{ error }`, never thrown: pi's bus swallows a throw, and the guard would read silence as "no router".
 */
export function answerMembers(request: unknown, provider: string, members: (id: string) => MemberModel[] | undefined): void {
	if (!isObject(request) || request.provider !== provider || typeof request.id !== "string" || typeof request.respond !== "function") return;
	const respond = request.respond as (value: unknown) => unknown;
	let listed: MemberModel[] | undefined;
	try {
		listed = members(request.id);
	} catch (error) {
		respond({ error: error instanceof Error ? error.message : String(error) });
		return;
	}
	if (listed) respond({ members: listed });
}

/** Where `listenForMembers` reads the live state from. */
export interface MembersSource {
	config(): Config;
	/** Whether `id` is a virtual model this extension has registered and routes now. */
	active(id: string): boolean;
	subscriptions(): readonly Subscription[];
	isProvider(name: string): boolean;
}

/** Answers members requests on pi's event bus until the returned function is called (ADR 0004). */
export function listenForMembers(events: { on(channel: string, handler: (data: unknown) => void): () => void }, source: MembersSource): () => void {
	return events.on(MEMBERS_CHANNEL, (request) =>
		answerMembers(request, source.config().virtualModel.provider, (id) =>
			source.active(id) ? routableMembers(source.config(), id, source.subscriptions(), source.isProvider) : undefined,
		),
	);
}
