// A stand-in for OpenAI-compatible chat providers. Each provider gets its own
// path (/provider-a/v1/...), so a scene can make one account hit a usage limit
// while another answers. Replies stream word by word with token usage, so pi
// shows them, counts tokens and prices them as it would for a real provider.
import { createServer, type Server } from "node:http";

export interface LlmRequest {
	provider: string;
	model: string;
	/** Text of the last user message. */
	lastUser: string;
	/** The system prompt, which tells a subagent child's role. */
	system: string;
	/** How many tool results the conversation already has. */
	toolResults: number;
	/** Names of the tools offered. */
	tools: string[];
}

export interface Reply {
	text?: string;
	toolCalls?: { name: string; arguments: Record<string, unknown> }[];
	error?: { status: number; message: string };
	/** Milliseconds per streamed word; larger models stream slower. */
	wordMs?: number;
}

export type LlmScript = (request: LlmRequest) => Reply;

interface WireMessage {
	role: string;
	content?: string | { type: string; text?: string }[] | null;
}

const textOf = (content: WireMessage["content"]): string => (typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join(""));

export function startLlm(script: LlmScript): Promise<{ url: string; server: Server }> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (data) => (body += data));
		req.on("end", () => respond(script, req.url ?? "", body, res));
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })),
	);
}

async function respond(script: LlmScript, url: string, body: string, res: import("node:http").ServerResponse): Promise<void> {
	const provider = url.split("/")[1] ?? "";
	if (url.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"data":[]}');
		return;
	}
	const wire = JSON.parse(body || "{}") as { model?: string; messages?: WireMessage[]; tools?: { function?: { name?: string } }[] };
	const messages = wire.messages ?? [];
	const request: LlmRequest = {
		provider,
		model: wire.model ?? "",
		lastUser: textOf(messages.filter((message) => message.role === "user").at(-1)?.content),
		system: messages
			.filter((message) => message.role === "system" || message.role === "developer")
			.map((message) => textOf(message.content))
			.join("\n"),
		toolResults: messages.filter((message) => message.role === "tool").length,
		tools: (wire.tools ?? []).map((tool) => tool.function?.name ?? ""),
	};
	const reply = script(request);
	if (reply.error) {
		res.writeHead(reply.error.status, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: reply.error.message, type: "error" } }));
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta: unknown, finish: string | null = null) =>
		res.write(
			`data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
		);
	chunk({ role: "assistant", content: "" });
	const words = (reply.text ?? "").split(/(?<= )/);
	for (const word of words) {
		chunk({ content: word });
		await new Promise((resolve) => setTimeout(resolve, reply.wordMs ?? 22));
	}
	(reply.toolCalls ?? []).forEach((call, index) => {
		chunk({
			tool_calls: [
				{ index, id: `call_${index}_${Date.now()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } },
			],
		});
	});
	chunk({}, reply.toolCalls?.length ? "tool_calls" : "stop");
	const completion = Math.max(1, words.length * 1.3);
	res.write(
		`data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", created: 0, model: request.model, choices: [], usage: { prompt_tokens: 3200, completion_tokens: Math.round(completion), total_tokens: 3200 + Math.round(completion) } })}\n\n`,
	);
	res.end("data: [DONE]\n\n");
}
