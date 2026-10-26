import type { DecisionEntry } from "./types.ts";

function answerText(id: string, answer: NonNullable<DecisionEntry["answers"]>[string]): string {
	switch (answer.type) {
		case "choice":
			return `${id}=${answer.choice} (${answer.confidence.toFixed(2)})`;
		case "score":
			return `${id}=${answer.score.toFixed(2)}`;
		case "bool":
			return `${id}=${answer.probability.toFixed(2)}`;
	}
}

/** One line for the TUI and `/tier log`: `⇄ task 4 · work=implement (0.91) · standard → mid (sticky)`. */
export function summarize(decision: DecisionEntry): string {
	const parts = [`task ${decision.task}`];
	if (decision.subagent) parts.push(`${decision.subagent.agent}${decision.subagent.mode === "skipped" ? " (not routed)" : ""}`);
	const work = decision.answers?.work;
	if (work) parts.push(answerText("work", work));
	if (decision.kind !== "classified") parts.push(decision.kind);
	// Dry-run's point is the tier a request would have used; the baseline tier is what ran.
	if (decision.kind === "dry-run" && decision.tier.candidate && decision.tier.candidate !== decision.tier.chosen)
		parts.push(`would use ${decision.tier.candidate}`);
	const model = decision.model.id ? `${decision.model.id}${decision.model.thinking ? `:${decision.model.thinking}` : ""}` : "";
	const target = decision.tier.chosen ? `${decision.tier.chosen}${decision.tier.borrowedFrom ? " (borrowed)" : ""} → ${model}` : decision.tier.why;
	parts.push(target + (decision.selection && !decision.selection.kept ? ` (${decision.selection.strategy})` : ""));
	if (decision.switch.cacheMiss) parts.push("cache miss");
	return `⇄ ${parts.join(" · ")}`;
}

/** "1 response", "2 responses". */
export function responseCount(n: number): string {
	return `${n} ${n === 1 ? "response" : "responses"}`;
}

/** The confidence gate of the matched rule; a catch-all rule reads no answer with a confidence, so has none. */
function gateText(gate: NonNullable<DecisionEntry["rules"]>["gate"]): string {
	if (gate.referenced.length === 0) return "no confidence gate";
	return `gate ${gate.confidence.toFixed(2)} vs ${gate.threshold} on [${gate.referenced.join(", ")}] ${gate.passed ? "passed" : "failed"}`;
}

/** The full explanation for `/tier explain` and expanded TUI entries. */
export function explain(decision: DecisionEntry): string[] {
	const lines: string[] = [];
	lines.push(`${decision.id} · ${decision.ts} · ${decision.scope} · ${decision.reason} · ${decision.kind}`);
	lines.push(`profile: ${decision.profile.name || "(none)"} (${decision.profile.source})${decision.virtualModel ? ` via ${decision.virtualModel}` : ""}`);
	if (decision.evidence)
		lines.push(
			`evidence: ${decision.evidence.tokens} tokens, digest ${decision.evidence.digest}${decision.evidence.truncated ? ", truncated" : ""}`,
			`  request: ${decision.evidence.excerpt.replace(/\s+/gu, " ").slice(0, 200)}`,
		);
	if (decision.classifier) {
		const c = decision.classifier;
		lines.push(
			`classifier: ${c.model ?? "none answered"} in ${c.latencyMs} ms${c.failure ? ` (${c.failure})` : ""}${c.usage ? `, ${c.usage.input} tokens` : ""}`,
		);
		for (const attempt of c.attempts.filter((a) => !a.ok)) lines.push(`  ✗ ${attempt.model}: ${attempt.error}${attempt.cold ? " (cold)" : ""}`);
	}
	if (decision.answers)
		lines.push(
			`answers: ${Object.entries(decision.answers)
				.map(([id, answer]) => answerText(id, answer))
				.join(", ")}`,
		);
	if (decision.rules) {
		const { gate } = decision.rules;
		lines.push(`rules: ${decision.rules.ruleset} rule ${decision.rules.matched + 1}; ${gateText(gate)}`);
		for (const floor of decision.rules.floors.filter((f) => f.applied))
			lines.push(`  floor ${floor.index + 1}: at least ${floor.atLeast}${floor.raised ? " (raised)" : ""}`);
	}
	lines.push(
		`tier: ${decision.tier.candidate || "-"} → ${decision.tier.chosen || "-"}${decision.tier.previous ? ` (was ${decision.tier.previous})` : ""}: ${decision.tier.why}`,
	);
	if (decision.selection) {
		const s = decision.selection;
		lines.push(
			`selection: ${s.strategy}/${s.granularity}: ${s.why}${s.metricFallback ? ` [${s.metricFallback}]` : ""}${s.shared ? "" : " [health not shared]"}`,
		);
		for (const candidate of s.candidates)
			lines.push(
				`  ${candidate.eligible ? "✓" : "✗"} ${candidate.member}${candidate.excluded ? `: ${candidate.excluded}` : ""}${candidate.inFlight ? `, ${candidate.inFlight} in flight` : ""}`,
			);
	}
	lines.push(
		`model: ${decision.model.provider}/${decision.model.id}:${decision.model.thinking}${decision.model.account ? ` on account ${decision.model.account}` : ""}${decision.switch.cacheMiss ? ` (switch from ${decision.switch.from}, cache miss)` : ""}`,
	);
	if (decision.error)
		lines.push(
			`error: ${decision.error.class}${decision.error.benchedUntil ? `, benched until ${decision.error.benchedUntil}` : ""}: ${decision.error.message}`,
		);
	if (decision.subagent)
		lines.push(
			`subagent: ${decision.subagent.agent} #${decision.subagent.taskIndex} ${decision.subagent.mode}${decision.subagent.skipped ? `: ${decision.subagent.skipped}` : ""}`,
		);
	if (decision.budget?.length) lines.push(`budget: ${decision.budget.map((b) => `${b.scope} ${b.metric} ${b.used.toFixed(2)}/${b.limit}`).join(", ")}`);
	return lines;
}
