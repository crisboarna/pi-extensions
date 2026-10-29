import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { greeting } from "./greeting.ts";

/** Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent. */
export default function extension(pi: ExtensionAPI): void {
	pi.registerCommand("context-refs", {
		description: "Save context refs and insert them from a picker as compact placeholders that expand to real content when the message is sent.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(greeting(ctx.cwd), "info");
		},
	});
}
