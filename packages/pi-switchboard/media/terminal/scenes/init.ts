// The demo session before pi-switchboard is configured, for the /tier init clip.
import type { SceneScript } from "../setup.ts";
import { scene as demo } from "./demo.ts";

export const scene: SceneScript = { ...demo, config: false };
