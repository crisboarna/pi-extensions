# Benchmarks

What pi-account-guard costs in time, measured and not estimated. Every number and chart on this page is generated from the recorded runs in `benchmarks/` by `npm run charts`.

## Start

![Time for pi to answer get_commands, alone and with pi-account-guard: the medians are 117.5 ms and 133.5 ms](benchmarks/load.svg)

| | Median | 10th to 90th percentile | Runs |
|---|---|---|---|
| pi alone | 117.5 ms | 116.4 to 120.0 ms | 30 |
| pi with pi-account-guard | 133.5 ms | 132.4 to 134.9 ms | 30 |

Loading pi-account-guard adds about 16.1 ms to pi's start (the difference of the two medians).

## How it was measured

- **baseline:** Real pi in RPC mode on an empty agent directory with no extension loaded; wall time from spawn to the get_commands answer. What each package's load time is read against.
- **load:** Real pi in RPC mode on an empty agent directory with the extension loaded; wall time from spawn to the get_commands answer.
- **Machine:** Node 24.19.0 on darwin arm64 with 18 CPUs, pi 1.4.0.
- **Code:** commit `42a85c6`, measured 2026-11-03.
- **Again:** `node scripts/bench.ts --samples 30 --write benchmarks`, then `npm run format` and `npm run charts`.

## What this does not tell you

- It is one machine. Another machine is slower or faster; the latency job in CI compares a change with its base on one machine and publishes no absolute numbers.
- The start time runs from starting pi to its first answer over RPC, not to the first reply from a model.
- A difference of a few milliseconds is inside the spread of the runs.
