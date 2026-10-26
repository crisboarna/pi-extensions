// The source unrefs its timers so pi can exit while a timer is pending. A
// test that waits on such a timer then has nothing keeping the event loop
// alive, and Node 22's test runner cancels it ("Promise resolution is still
// pending but the event loop has already resolved"). Test files that wait on
// unref'd timers call this once at the top level.
import { after, before } from "node:test";

export function keepEventLoopAlive(): void {
	let handle: ReturnType<typeof setInterval> | undefined;
	before(() => {
		handle = setInterval(() => undefined, 60_000);
	});
	after(() => clearInterval(handle));
}
