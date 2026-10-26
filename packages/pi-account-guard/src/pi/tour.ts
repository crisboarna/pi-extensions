import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TOUR_STEPS, type TourStep } from "../core/tour.ts";

const NEXT = "Next →";
const CLOSE = "Close";

/** Runs the tour through pi's dialogs; without the TUI, prints every step. Returns how many steps were shown. */
export async function runTour(
	ctx: { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "select" | "notify"> },
	steps: readonly TourStep[] = TOUR_STEPS,
): Promise<number> {
	if (!ctx.hasUI) {
		ctx.ui.notify(steps.map((step, i) => [`${i + 1}/${steps.length} ${step.title}`, ...step.lines].join("\n")).join("\n\n"), "info");
		return steps.length;
	}
	for (const [index, step] of steps.entries()) {
		const last = index === steps.length - 1;
		const title = [`pi-account-guard tour ${index + 1}/${steps.length}: ${step.title}`, "", ...step.lines].join("\n");
		const choice = await ctx.ui.select(title, last ? [CLOSE] : [NEXT, CLOSE]);
		if (choice !== NEXT) return index + 1;
	}
	return steps.length;
}
