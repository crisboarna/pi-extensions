// Real pi's interactive mode, in this process, on a VirtualTerminal: no binary, no pty. The package's
// extension and the stub provider load as inline extension factories, so a test types keys and reads
// the screen the way `pty-session.ts` does, in a fraction of the time and inside the coverage run.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	InteractiveMode,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import contextRefs from "../../src/index.ts";
import stubProvider, { STUB_MODEL, STUB_PROVIDER } from "./stub-provider.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

export interface TuiOptions {
	/** Library file for the Global library; omit for none. */
	library?: unknown;
	/** Written as the agent directory's `settings.json`, for example `{ tuiMode: "regular" }`. */
	settings?: Record<string, unknown>;
	/** Environment the stub provider reads (`STUB_*`); set for the session and restored on close. */
	env?: Record<string, string>;
	columns?: number;
	rows?: number;
	/** Extensions to load besides the package's and the stub provider's. */
	extensions?: ExtensionFactory[];
}

type Runtime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;

export class TuiSession {
	readonly terminal: VirtualTerminal;
	readonly project: string;
	readonly agentDir: string;
	readonly #mode: InteractiveMode;
	readonly #runtime: Runtime;
	readonly #restoreEnv: () => void;
	#running: Promise<void> = new Promise(() => {});

	private constructor(terminal: VirtualTerminal, project: string, agentDir: string, mode: InteractiveMode, runtime: Runtime, restoreEnv: () => void) {
		this.terminal = terminal;
		this.project = project;
		this.agentDir = agentDir;
		this.#mode = mode;
		this.#runtime = runtime;
		this.#restoreEnv = restoreEnv;
	}

	static async start(options: TuiOptions = {}): Promise<TuiSession> {
		const root = mkdtempSync(join(tmpdir(), "context-refs-tui-"));
		const project = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(project);
		mkdirSync(agentDir);
		if (options.library !== undefined) writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify(options.library));
		if (options.settings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));

		const saved = new Map<string, string | undefined>();
		const setEnv = (key: string, value: string) => {
			if (!saved.has(key)) saved.set(key, process.env[key]);
			process.env[key] = value;
		};
		setEnv("PI_CODING_AGENT_DIR", agentDir);
		setEnv("PI_OFFLINE", "1");
		for (const [key, value] of Object.entries(options.env ?? {})) setEnv(key, value);
		const restoreEnv = () => {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		};

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					extensionFactories: [stubProvider, contextRefs, ...(options.extensions ?? [])],
				},
			});
			const model = services.modelRuntime.getModel(STUB_PROVIDER, STUB_MODEL);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					...(sessionStartEvent ? { sessionStartEvent } : {}),
					...(model ? { model } : {}),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, { cwd: project, agentDir, sessionManager: SessionManager.inMemory() });
		const terminal = new VirtualTerminal({
			...(options.columns !== undefined ? { columns: options.columns } : {}),
			...(options.rows !== undefined ? { rows: options.rows } : {}),
		});
		const mode = new InteractiveMode(runtime, { terminal });
		const session = new TuiSession(terminal, project, agentDir, mode, runtime, restoreEnv);
		// `run` initialises the UI, then loops on the editor's submits and never returns: it is raced, not awaited.
		session.#running = mode.run();
		return session;
	}

	/** Resolves when the editor is drawn and takes keystrokes. */
	async ready(): Promise<void> {
		await Promise.race([this.terminal.waitForScreen((screen) => screen.includes(STUB_MODEL)), this.#running]);
	}

	/** The editor's text as drawn: the rows between the last two rules, which frame it above the footer. */
	async editor(): Promise<string> {
		const rows = (await this.terminal.screen()).split("\n");
		const rules = rows.flatMap((row, index) => (/^─{20,}\s*$/.test(row) ? [index] : []));
		const [top, bottom] = rules.slice(-2);
		if (top === undefined || bottom === undefined) return "";
		return rows
			.slice(top + 1, bottom)
			.map((row) => row.trim())
			.join("\n")
			.trim();
	}

	/** Resolves with the editor's text once `match` accepts it. */
	async waitForEditor(match: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const text = await this.editor();
			if (match(text)) return text;
			if (Date.now() > deadline) throw new Error(`timed out waiting for the editor; it holds ${JSON.stringify(text)}\n${await this.terminal.screen()}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async close(): Promise<void> {
		// Never send Ctrl+D on an empty editor, Ctrl+C twice or `/quit` in a test: pi's shutdown ends in `process.exit`.
		this.#mode.stop();
		await this.#runtime.dispose();
		this.terminal.dispose();
		this.#restoreEnv();
	}
}
