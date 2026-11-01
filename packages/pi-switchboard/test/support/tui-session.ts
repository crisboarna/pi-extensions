// Real pi's interactive mode, in this process, on a VirtualTerminal: no binary, no pty. The extension and the stub
// providers load as inline extension factories, so a test presses keys in pi's real TUI and reads the screen, inside
// the coverage run. `test/e2e` keeps the subprocess tests of routing and failover.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
import switchboard from "../../src/index.ts";
import tuiStubProviders from "./tui-stub-provider.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const PROVIDER = "acme";
const MODEL = "mid";

export interface TuiOptions {
	/** The `pi-switchboard.json` of the session; omit for none. */
	config?: unknown;
	/** Environment for the session, set on start and restored on close. */
	env?: Record<string, string>;
	columns?: number;
	rows?: number;
	/** Extensions to load besides the switchboard and the stub providers. */
	extensions?: ExtensionFactory[];
}

type Runtime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;

export class TuiSession {
	readonly terminal: VirtualTerminal;
	/** The directory pi runs in. */
	readonly project: string;
	/** Where the config file is written; `PI_SWITCHBOARD_CONFIG` points at it. */
	readonly configPath: string;
	readonly agentDir: string;
	readonly #mode: InteractiveMode;
	readonly #runtime: Runtime;
	readonly #restoreEnv: () => void;
	#running: Promise<void> = new Promise(() => {});

	private constructor(
		terminal: VirtualTerminal,
		project: string,
		configPath: string,
		agentDir: string,
		mode: InteractiveMode,
		runtime: Runtime,
		restoreEnv: () => void,
	) {
		this.terminal = terminal;
		this.project = project;
		this.configPath = configPath;
		this.agentDir = agentDir;
		this.#mode = mode;
		this.#runtime = runtime;
		this.#restoreEnv = restoreEnv;
	}

	static async start(options: TuiOptions = {}): Promise<TuiSession> {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "switchboard-tui-")));
		const project = join(root, "project");
		const configPath = join(root, "pi-switchboard.json");
		const agentDir = join(root, "agent");
		mkdirSync(project);
		mkdirSync(agentDir);
		if (options.config !== undefined) writeFileSync(configPath, JSON.stringify(options.config));

		const saved = new Map<string, string | undefined>();
		const setEnv = (key: string, value: string) => {
			if (!saved.has(key)) saved.set(key, process.env[key]);
			process.env[key] = value;
		};
		setEnv("PI_CODING_AGENT_DIR", agentDir);
		setEnv("PI_OFFLINE", "1");
		if (options.config !== undefined) setEnv("PI_SWITCHBOARD_CONFIG", configPath);
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
					extensionFactories: [tuiStubProviders, switchboard, ...(options.extensions ?? [])],
				},
			});
			const model = services.modelRuntime.getModel(PROVIDER, MODEL);
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
		const session = new TuiSession(terminal, project, configPath, agentDir, mode, runtime, restoreEnv);
		// `run` initialises the UI, then loops on the editor's submits and never returns: it is raced, not awaited.
		session.#running = mode.run();
		return session;
	}

	/** The id the session's children name as their parent in `<data dir>/live/*.json`. */
	get sessionId(): string {
		return this.#runtime.session.sessionManager.getSessionId();
	}

	/** Where the switchboard keeps its files for this session's agent directory. */
	get dataDir(): string {
		return join(this.agentDir, "pi-switchboard");
	}

	/** Resolves when the editor is drawn and takes keystrokes. */
	async ready(): Promise<void> {
		await Promise.race([this.terminal.waitForScreen((screen) => screen.includes(`(${PROVIDER}) ${MODEL}`)), this.#running]);
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
