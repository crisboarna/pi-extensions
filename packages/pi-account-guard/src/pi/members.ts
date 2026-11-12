import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMBERS_CHANNEL, type MemberRef, type MembersAnswer, parseMembersAnswer } from "../core/members.ts";

/**
 * Asks the router that owns `model` for the models behind it (ADR 0006). pi's event bus calls every handler during `emit`, so an
 * answer comes at once or not at all; one that comes later is ignored, and with no answer the model is checked as its own account.
 */
export function askMembers(events: ExtensionAPI["events"], model: MemberRef): MembersAnswer {
	let open = true;
	let answered = false;
	let answer: unknown;
	events.emit(MEMBERS_CHANNEL, {
		provider: model.provider,
		id: model.id,
		respond(value: unknown): boolean {
			if (!open || answered) return false;
			answered = true;
			answer = value;
			return true;
		},
	});
	open = false;
	return answered ? parseMembersAnswer(answer) : { status: "none" };
}
