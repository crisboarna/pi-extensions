import type { BudgetLimits, Budgets } from "../config/types.ts";

export interface Spend {
	tokens: number;
	costUsd: number;
}

export interface BudgetStatus {
	scope: "task" | "session";
	metric: "tokens" | "costUsd";
	used: number;
	limit: number;
}

/**
 * Soft budgets (DESIGN.md 9.7): tracks spend per task and session and
 * reports each budget crossed. Routing never changes because of a budget;
 * `newlyCrossed` lets the caller notify once per budget.
 */
export class BudgetTracker {
	private task = 0;
	private readonly spend = { task: { tokens: 0, costUsd: 0 }, session: { tokens: 0, costUsd: 0 } };
	private readonly notified = new Set<string>();

	startTask(task: number): void {
		if (task === this.task) return;
		this.task = task;
		this.spend.task = { tokens: 0, costUsd: 0 };
		for (const key of [...this.notified]) if (key.startsWith("task:")) this.notified.delete(key);
	}

	add(tokens: number, costUsd: number): void {
		for (const scope of [this.spend.task, this.spend.session]) {
			scope.tokens += tokens;
			scope.costUsd += costUsd;
		}
	}

	totals(): { task: Spend; session: Spend } {
		return { task: { ...this.spend.task }, session: { ...this.spend.session } };
	}

	/** Budgets currently exceeded, for decision records and the footer. */
	exceeded(budgets: Budgets | undefined): BudgetStatus[] {
		const out: BudgetStatus[] = [];
		const check = (scope: "task" | "session", limits: BudgetLimits | undefined) => {
			if (!limits) return;
			const spent = this.spend[scope];
			if (limits.tokens !== undefined && spent.tokens > limits.tokens) out.push({ scope, metric: "tokens", used: spent.tokens, limit: limits.tokens });
			if (limits.costUsd !== undefined && spent.costUsd > limits.costUsd)
				out.push({ scope, metric: "costUsd", used: spent.costUsd, limit: limits.costUsd });
		};
		check("task", budgets?.task);
		check("session", budgets?.session);
		return out;
	}

	/** Exceeded budgets not reported before. */
	newlyCrossed(budgets: Budgets | undefined): BudgetStatus[] {
		return this.exceeded(budgets).filter((status) => {
			const key = `${status.scope}:${status.metric}`;
			if (this.notified.has(key)) return false;
			this.notified.add(key);
			return true;
		});
	}
}
