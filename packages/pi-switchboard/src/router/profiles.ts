import type { Config, Profile } from "../config/types.ts";
import type { ProfileSource } from "../record/types.ts";
import { matchGlob } from "../util/glob.ts";

export interface ProfileChoice {
	profile: Profile;
	source: ProfileSource;
	/** Index of the selection rule that matched, for `match`. */
	rule?: number;
}

export interface ProfileInputs {
	config: Config;
	/** A profile named by the selected virtual model (`switchboard/<profile>`). */
	fromModel?: string;
	manualSession?: string;
	manualGlobal?: string | undefined;
	/** The physical model selected before routing, `provider/id`. */
	originModel?: string;
	cwd: string;
	home: string;
}

/** Whether a profile may be used in `cwd`; profiles without `projects` work everywhere. */
export function profileAllowedHere(profile: Profile, cwd: string, home: string): boolean {
	if (profile.projects.length === 0) return true;
	const expand = (pattern: string) => (pattern.startsWith("~/") ? `${home}${pattern.slice(1)}` : pattern);
	return profile.projects.some((pattern) => {
		// A trailing /** means the folder and everything under it; a plain path also covers its subfolders.
		const base = expand(pattern)
			.replace(/\/$/u, "")
			.replace(/\/\*\*$/u, "");
		return matchGlob(base, cwd) || matchGlob(`${base}/*`, cwd);
	});
}

/**
 * The active profile (DESIGN.md 7.3): a model-named profile, then the manual
 * session choice, the manual global choice, the project's profile, the first
 * matching selection rule for the origin model, and the default. Profiles not
 * valid here are skipped.
 */
export function chooseProfile(inputs: ProfileInputs): ProfileChoice | undefined {
	const { config } = inputs;
	const usable = (name: string | undefined): Profile | undefined => {
		const profile = name ? config.profiles[name] : undefined;
		return profile && profileAllowedHere(profile, inputs.cwd, inputs.home) ? profile : undefined;
	};
	const ordered: Array<[string | undefined, ProfileSource]> = [
		[inputs.fromModel, "model"],
		[inputs.manualSession, "manual-session"],
		[inputs.manualGlobal, "manual-global"],
		[config.projectProfile, "project"],
	];
	for (const [name, source] of ordered) {
		const profile = usable(name);
		if (profile) return { profile, source };
	}
	if (inputs.originModel) {
		const provider = inputs.originModel.slice(0, inputs.originModel.indexOf("/"));
		for (const [index, rule] of config.profileSelection.rules.entries()) {
			const hit = (rule.matchProvider && matchGlob(rule.matchProvider, provider)) || (rule.matchModel && matchGlob(rule.matchModel, inputs.originModel));
			const profile = hit ? usable(rule.profile) : undefined;
			if (profile) return { profile, source: "match", rule: index };
		}
	}
	const fallback = usable(config.profileSelection.default);
	if (fallback) return { profile: fallback, source: "default" };
	const only = Object.values(config.profiles).filter((profile) => profileAllowedHere(profile, inputs.cwd, inputs.home));
	return only.length === 1 && only[0] ? { profile: only[0], source: "default" } : undefined;
}

/** Why no profile is active, for the footer and `/tier`. */
export function inactiveReason(config: Config, missingConfig: boolean): string {
	if (missingConfig) return "no config; run /tier init";
	const invalid = Object.keys(config.invalidProfiles);
	if (Object.keys(config.profiles).length === 0)
		return invalid.length ? `every profile is invalid (${invalid.join(", ")}); run /tier validate` : "no profiles configured";
	return "no profile matches; set profileSelection.default";
}
