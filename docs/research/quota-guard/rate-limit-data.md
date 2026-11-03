# Rate-limit data the guarded providers send

Findings for the pi-quota-guard map ticket "What rate-limit data do the anthropic subscription login and claude-bridge actually send?". Captured on 2026-11-03 with pi 1.4.0, pi-claude-bridge 0.9.3 and the installed Claude Code CLI, on `claude-haiku-4-5`. Never merged.

## How it was captured

- A throwaway extension logged every `before_provider_request`, `after_provider_response` (status, `anthropic-ratelimit*` headers, `isUsingOAuth`), `tool_execution_start` and assistant `message_end` (provider, model, stop reason, `usage`) to a JSONL file.
- pi ran headless with a temporary `PI_CODING_AGENT_DIR` and `CLAUDE_BRIDGE_DEBUG=1`, two prompts: a one-line reply, and a turn with three sequential `bash` calls.
- `claude -p --output-format stream-json --verbose` ran the three-call prompt directly, to see the raw `rate_limit_event` without the bridge. The user's Claude Code hooks stalled the first try; `--setting-sources=""` avoided them.

Fixtures, redacted (no session ids, uuids or account ids; times relative to the first event):

- `fixtures/bridge-pi-events.jsonl`: what a pi extension sees from `claude-bridge`.
- `fixtures/claude-code-stream.jsonl`: the raw Claude Code `rate_limit_event`, assistant usage and `result`.

## claude-bridge

- **Windows.** Only `7d` appears. There is no `5h` and no `7d_oi` on this account. The representative claim is `seven_day`. Headers sent: `status`, `reset`, `representative-claim`, `overage-status`, `7d-utilization`, `7d-reset`. The bridge drops `overageDisabledReason`, `isUsingOverage` and the per-window `status` that Claude Code sends.
- **Frequency.** Not one Snapshot per reply. Claude Code sent one `rate_limit_event` per query, after the first API request, not one per request. The three-call pi turn made four bridge calls and got one Snapshot. The README's "when a usage window changes" and the source comment's "one event per request" are both wrong for this run; design for "at most one per query, maybe none".
- **Held event.** Seen. In the three-call turn the event arrived as the first call ended on `toolUse` (t=3696 ms in the fixture) and was reported on the next call (t=3876 ms), before that call's assistant message. A Snapshot can trail by one call, as the map assumed.
- **Precision.** `utilization` was `0.22`: a fraction with two decimals, so whole percent. Nothing finer was seen. One run cannot prove the field is always rounded.
- **Reset values.** Unix seconds as a decimal string in the header (`1794081600` = 2026-11-07T20:00:00Z); a number in the raw event.
- **`unifiedWindows`.** Filled in on every event seen. The top-level `utilization` was absent, as expected when the status is `allowed` (the bridge reads it only for `allowed_warning`). A missing `unifiedWindows` was not seen.
- **Cost.** `message_end` `usage.cost` is all zeros on every bridge turn, though token counts are filled in. Claude Code's own `result` reports `total_cost_usd` 0.025 for the same prompt; the bridge does not pass it on. A Cost Meter must compute cost from tokens and the model's prices itself.
- **OAuth.** `ctx.modelRegistry.isUsingOAuth(model)` returns `false` for `claude-bridge`. The guard must not use it to decide whether bridge traffic counts; the settled rule "claude-bridge always counts" is needed.
- **Status code.** Always 200, as the bridge documents.

## anthropic with the subscription login

Not run live: the user chose to skip the OAuth login in the temporary agent directory. From pi-ai 1.4.0's source (`dist/api/anthropic-messages.js`):

- `onResponse` runs once per HTTP response with every response header (line 475), so a Snapshot should arrive on every reply. Whether the subscription API sends `5h` for this plan was not seen.
- `calculateCost` runs whatever the auth (lines 502, 682), so subscription turns carry a non-zero API-equivalent `cost`.

## Not seen

- A rejected window, `allowed_warning`, or overage in use. Overage is `rejected` with `org_level_disabled` on this account, so the overage headers are present but always say rejected. Provoking a rejection would spend real quota.
- The anthropic headers live, including their precision and whether `5h` appears.
