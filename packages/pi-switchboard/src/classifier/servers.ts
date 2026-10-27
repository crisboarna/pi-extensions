import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The local classifier servers detect and setup know, read from data/classifier-servers.json: where each
 * listens, how it marks decision models in its model list, which models the measurements recommend, and
 * the commands setup shows and runs. Product names and model ids live in that file, not in src/.
 */
export type Listing = "type-field" | "show-capabilities" | "output-modalities";

export interface ServerSpec {
	kind: string;
	label: string;
	/** The provider name the config gives it. */
	name: string;
	/** Scheme, host and port. */
	origin: string;
	listing: Listing;
	/** For servers that also serve chat models a pi provider can read as classifiers: the hint, with {models} and {origin}. */
	chatHint?: string;
	/** That pi provider's name. */
	chatProvider?: string;
}

export interface SetupSpec {
	/** The server kind this sets up; defaults to the setup's own name. */
	server?: string;
	/** Commands to look for, in order; `~` is the home directory. */
	commands: string[];
	install: string;
	/** Commands setup runs after showing them; `{bin}` is the command found. */
	run?: string[][];
	/** A server the user starts in another terminal; setup prints it and waits for the server. */
	serve?: string[];
	/** How to start a server setup cannot start itself. */
	serverHint?: string;
	/** The model the setup provides. */
	model: string;
	/** A chat model read through a pi provider, not a decision model. */
	chat?: boolean;
}

export interface ServerCatalog {
	servers: ServerSpec[];
	preferred: string[];
	setups: Record<string, SetupSpec>;
}

let catalog: ServerCatalog | undefined;

/** The catalog shipped with the package. */
export function serverCatalog(): ServerCatalog {
	catalog ??= JSON.parse(readFileSync(fileURLToPath(new URL("../../data/classifier-servers.json", import.meta.url)), "utf8")) as ServerCatalog;
	return catalog;
}
