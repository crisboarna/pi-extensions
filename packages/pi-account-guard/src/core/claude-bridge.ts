import { posix } from "node:path";

/** The provider id that gets the built-in resolver, because pi's auth snapshot only sees a placeholder key for it (DESIGN.md section 6). */
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";

/** The source of every cloud provider and `apiKeyHelper` setup. */
const CLAUDE_CODE_SOURCE = "claude-code";

/** Claude Code tests these in this order and the first one set wins (DESIGN.md section 6, point 1). */
const CLOUD_PROVIDER_VARIABLES = [
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_VERTEX",
];

/** The credential variables in the order the resolver takes them (DESIGN.md section 6, points 2 to 5). */
const CREDENTIAL_VARIABLES = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

const TRUTHY_VALUES = ["1", "true", "yes", "on"];

export interface ClaudeBridgeEnvironment {
	env: Record<string, string | undefined>;
	home: string;
	/** Whether the Claude Code settings of the config directory define an `apiKeyHelper`. Must not return or keep the helper command. */
	usesApiKeyHelper(configDirectory: string): boolean;
}

/** The auth source of a claude-bridge model: where Claude Code takes its login from. The values of the variables are never read. */
export function claudeBridgeSource({ env, home, usesApiKeyHelper }: ClaudeBridgeEnvironment): string {
	if (CLOUD_PROVIDER_VARIABLES.some((name) => TRUTHY_VALUES.includes((env[name] ?? "").trim().toLowerCase()))) return CLAUDE_CODE_SOURCE;
	const credential = CREDENTIAL_VARIABLES.find((name) => (env[name] ?? "") !== "");
	if (credential) return `env:${credential}`;
	const configDirectory = resolveConfigDirectory(env.CLAUDE_CONFIG_DIR, home);
	if (usesApiKeyHelper(configDirectory)) return CLAUDE_CODE_SOURCE;
	return `claude-config:${displayDirectory(configDirectory, home)}`;
}

/** The absolute Claude Code config directory: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
function resolveConfigDirectory(configured: string | undefined, home: string): string {
	const path = configured === undefined || configured.trim() === "" ? "~/.claude" : configured;
	const expanded = path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
	return posix.resolve(home, expanded);
}

function displayDirectory(path: string, home: string): string {
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Whether Claude Code settings text defines a non-empty `apiKeyHelper`. Reads nothing else from the text; malformed text counts as no helper. */
export function definesApiKeyHelper(settingsText: string | undefined): boolean {
	if (settingsText === undefined) return false;
	try {
		const settings: unknown = JSON.parse(settingsText);
		if (typeof settings !== "object" || settings === null) return false;
		const helper = (settings as Record<string, unknown>).apiKeyHelper;
		return typeof helper === "string" && helper.trim() !== "";
	} catch {
		return false;
	}
}
