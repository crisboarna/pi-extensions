// The README and docs clips: one scene per clip, the demo repository and library only.
//
// Called by: media/terminal/setup.ts (scene "clips"), media/manifest.json.
import type { RefsScene } from "../setup.ts";
import { reply } from "./demo.ts";

export const clipScene: RefsScene = { llm: reply };
export const headlessScene: RefsScene = { shell: true, llm: reply };
