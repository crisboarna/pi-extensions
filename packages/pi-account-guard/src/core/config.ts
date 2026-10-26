import { sameAccount, type AccountKey } from "./account.ts";

export interface AccountTag {
	provider: string;
	source: string;
	zones: string[];
	note?: string;
}

export interface PathPlaceRule {
	path: string;
	zone: string;
	note?: string;
}

export interface GuardConfig {
	zones: string[];
	defaultZone: string;
	accounts: AccountTag[];
	places: PathPlaceRule[];
}

export interface ConfigError {
	/** JSON path such as `accounts[3].zones`; empty for the whole file. */
	path: string;
	message: string;
}

export type ConfigResult = { ok: true; config: GuardConfig } | { ok: false; errors: ConfigError[] };

/** The config of a missing file: no rules, no tags. */
export const DEFAULT_CONFIG: GuardConfig = { zones: ["work", "personal"], defaultZone: "personal", accounts: [], places: [] };

const RESERVED_ZONE = "unknown";

/** Parses and validates the file text; `undefined` stands for a missing file. Validation is strict and all-or-nothing. */
export function parseConfig(text: string | undefined): ConfigResult {
	if (text === undefined) return { ok: true, config: DEFAULT_CONFIG };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return { ok: false, errors: [{ path: "", message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }] };
	}
	const errors: ConfigError[] = [];
	const config = validate(value, errors);
	return errors.length === 0 && config ? { ok: true, config } : { ok: false, errors };
}

/** One line per error: `<file>: <json path>: <message>`. */
export function formatConfigErrors(errors: ConfigError[], fileName: string): string[] {
	return errors.map((error) => (error.path ? `${fileName}: ${error.path}: ${error.message}` : `${fileName}: ${error.message}`));
}

/** The zones tagged on an account, or `undefined` when it is untagged (the Unknown zone). */
export function accountZones(accounts: AccountTag[], key: AccountKey): string[] | undefined {
	return accounts.find((account) => sameAccount(account, key))?.zones;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function rejectUnknownFields(object: JsonObject, allowed: string[], path: string, errors: ConfigError[]): void {
	for (const field of Object.keys(object)) if (!allowed.includes(field)) errors.push({ path, message: `unknown field "${field}"` });
}

function readNote(object: JsonObject, path: string, errors: ConfigError[]): { note?: string } {
	if (object.note === undefined) return {};
	if (typeof object.note !== "string") {
		errors.push({ path: `${path}.note`, message: "must be a string" });
		return {};
	}
	return { note: object.note };
}

function validate(value: unknown, errors: ConfigError[]): GuardConfig | undefined {
	if (!isObject(value)) {
		errors.push({ path: "", message: "must be an object" });
		return undefined;
	}
	rejectUnknownFields(value, ["zones", "defaultZone", "accounts", "places"], "", errors);
	const zones = readZones(value.zones, errors);
	// With an unreadable zones list every reference would also fail; report only the root cause.
	const declared = (zone: string) => zones === undefined || zones.includes(zone);
	const undeclared = (path: string, zone: string) => errors.push({ path, message: `zone "${zone}" is not declared in zones` });

	let defaultZone = DEFAULT_CONFIG.defaultZone;
	if (value.defaultZone !== undefined) {
		if (isName(value.defaultZone)) defaultZone = value.defaultZone;
		else errors.push({ path: "defaultZone", message: "must be a zone name" });
	}
	if (!declared(defaultZone)) undeclared("defaultZone", defaultZone);

	return { zones: zones ?? [], defaultZone, accounts: readAccounts(value.accounts, declared, undeclared, errors), places: readPlaces(value.places, declared, undeclared, errors) };
}

function readZones(value: unknown, errors: ConfigError[]): string[] | undefined {
	if (value === undefined) return [...DEFAULT_CONFIG.zones];
	if (!Array.isArray(value)) {
		errors.push({ path: "zones", message: "must be an array of zone names" });
		return undefined;
	}
	const zones: string[] = [];
	value.forEach((zone, index) => {
		if (!isName(zone)) errors.push({ path: `zones[${index}]`, message: "must be a non-empty string" });
		else if (zone === RESERVED_ZONE) errors.push({ path: `zones[${index}]`, message: `"${RESERVED_ZONE}" is reserved and cannot be declared` });
		else zones.push(zone);
	});
	return zones;
}

type Undeclared = (path: string, zone: string) => void;

function readAccounts(value: unknown, declared: (zone: string) => boolean, undeclared: Undeclared, errors: ConfigError[]): AccountTag[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push({ path: "accounts", message: "must be an array" });
		return [];
	}
	const accounts: AccountTag[] = [];
	value.forEach((entry, index) => {
		const path = `accounts[${index}]`;
		if (!isObject(entry)) return void errors.push({ path, message: "must be an object" });
		rejectUnknownFields(entry, ["provider", "source", "zones", "note"], path, errors);
		const { provider, source } = entry;
		if (!isName(provider)) errors.push({ path: `${path}.provider`, message: "must be a non-empty string" });
		if (!isName(source)) errors.push({ path: `${path}.source`, message: "must be a non-empty string" });
		const zones = readTagZones(entry.zones, path, declared, undeclared, errors);
		const note = readNote(entry, path, errors);
		if (!isName(provider) || !isName(source) || !zones) return;
		const first = accounts.findIndex((account) => sameAccount(account, { provider, source }));
		if (first >= 0) errors.push({ path, message: `duplicate of accounts[${first}] (${provider} · ${source})` });
		accounts.push({ provider, source, zones, ...note });
	});
	return accounts;
}

function readTagZones(value: unknown, path: string, declared: (zone: string) => boolean, undeclared: Undeclared, errors: ConfigError[]): string[] | undefined {
	if (!Array.isArray(value)) {
		errors.push({ path: `${path}.zones`, message: "must be an array of zone names" });
		return undefined;
	}
	if (value.length === 0) {
		errors.push({ path: `${path}.zones`, message: "must list at least one zone" });
		return undefined;
	}
	const zones: string[] = [];
	value.forEach((zone, index) => {
		if (!isName(zone)) errors.push({ path: `${path}.zones[${index}]`, message: "must be a non-empty string" });
		else if (!declared(zone)) undeclared(`${path}.zones[${index}]`, zone);
		else zones.push(zone);
	});
	return zones.length === value.length ? zones : undefined;
}

function readPlaces(value: unknown, declared: (zone: string) => boolean, undeclared: Undeclared, errors: ConfigError[]): PathPlaceRule[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		errors.push({ path: "places", message: "must be an array" });
		return [];
	}
	const places: PathPlaceRule[] = [];
	value.forEach((entry, index) => {
		const path = `places[${index}]`;
		if (!isObject(entry)) return void errors.push({ path, message: "must be an object" });
		rejectUnknownFields(entry, ["path", "zone", "note"], path, errors);
		const note = readNote(entry, path, errors);
		let rulePath: string | undefined;
		if (entry.path === undefined) errors.push({ path, message: "needs a path" });
		else if (!isName(entry.path)) errors.push({ path: `${path}.path`, message: "must be a non-empty string" });
		else if (!entry.path.startsWith("/") && entry.path !== "~" && !entry.path.startsWith("~/")) errors.push({ path: `${path}.path`, message: "must be absolute or start with ~" });
		else rulePath = entry.path;
		let zone: string | undefined;
		if (!isName(entry.zone)) errors.push({ path: `${path}.zone`, message: "must be a zone name" });
		else if (!declared(entry.zone)) undeclared(`${path}.zone`, entry.zone);
		else zone = entry.zone;
		if (rulePath !== undefined && zone !== undefined) places.push({ path: rulePath, zone, ...note });
	});
	return places;
}
