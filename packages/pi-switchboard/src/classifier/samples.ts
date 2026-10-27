/**
 * Requests with the tier a reviewer chose before any classifier ran, for a
 * three-tier profile on the built-in rules: bottom, middle, top, or middle+
 * (at least the middle tier, for risky one-liners). `pi-switchboard
 * classifier eval` replays them; the routing tests replay recorded answers to
 * the same requests (test/fixtures/h2o-calibration.json).
 */
export type ExpectedTier = "bottom" | "middle" | "top" | "middle+";

export interface SampleRequest {
	request: string;
	expected: ExpectedTier;
}

export const SAMPLE_REQUESTS: readonly SampleRequest[] = [
	{ request: "rename the variable foo to bar in utils.ts", expected: "bottom" },
	{ request: "run the unit tests and tell me if they pass", expected: "bottom" },
	{ request: "what does the --frozen-lockfile flag do in pnpm?", expected: "bottom" },
	{ request: "summarize the last commit message", expected: "bottom" },
	{ request: "fix the typo in README line 12", expected: "bottom" },
	{ request: "add a .gitignore entry for .env", expected: "bottom" },
	{ request: "find where the retry logic for HTTP calls lives in this repo", expected: "bottom" },
	{ request: "list all files that import the logger module", expected: "bottom" },
	{ request: "implement pagination for the /orders endpoint with tests", expected: "middle" },
	{ request: "add a dark mode toggle to the settings page", expected: "middle" },
	{ request: "write a unit test for the parseDate helper", expected: "middle" },
	{ request: "fix the bug where the cart total ignores discounts", expected: "middle" },
	{ request: "refactor the user service to use dependency injection", expected: "middle" },
	{ request: "research how other projects handle rate limiting in Express and compare three libraries", expected: "middle" },
	{ request: "design the architecture for a multi-tenant billing service with event sourcing", expected: "top" },
	{ request: "plan the migration from REST to GraphQL across our 40 microservices", expected: "top" },
	{ request: "review this PR for security issues in the auth middleware", expected: "top" },
	{ request: "debug this intermittent race condition in the job scheduler that only shows up under load", expected: "top" },
	{ request: "choose between Postgres and DynamoDB for our event store and justify it", expected: "top" },
	{ request: "review the database schema for scaling problems", expected: "top" },
	{ request: "drop the users table in prod and recreate it from the backup", expected: "middle+" },
	{ request: "rotate the AWS access keys used by the deploy pipeline", expected: "middle+" },
	{ request: "delete all feature branches older than 6 months on origin", expected: "middle+" },
	{ request: "bump the version in package.json to 2.3.1", expected: "bottom" },
];
