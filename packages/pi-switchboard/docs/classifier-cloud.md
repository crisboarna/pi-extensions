# Cloud classifiers

pi includes hosted classifier models, built for exactly this kind of typed question: OpenAI's GPT-6 Luna, TypeSafe's Jev and Cloudflare's Clef. pi-switchboard uses any of them with one config entry and no server to run. They are remote: your request text (after redaction, see [what the classifier sees](classifier-setup.md#what-the-classifier-sees)) leaves the machine, and each request is billed by the provider. pi-switchboard skips a remote classifier unless its entry sets `"allowRemote": true`.

Chat models such as Haiku are not classifiers: they write text and give no probabilities for the confidence gate, so pi-switchboard does not accept them.

None of these was measured for this guide (they need paid accounts). On 2026-10-28 the model ids in the table were checked against pi 1.4's catalog, where each is a classifier, and GPT-6 Luna without a key was run through `/tier doctor` and `/tier eval`: skipped without `allowRemote`, and with it a clear "Provider is not configured" pointing to the key. `/tier eval <model>` measures one on your account with pi-switchboard's 24 sample texts, after a confirm.

| Classifier | Model id in pi-switchboard | Credentials |
|---|---|---|
| GPT-6 Luna (OpenAI Decisions API) | `openai/gpt-6-luna` | `OPENAI_API_KEY`. Not a ChatGPT login: while `openai` is logged in through `/login`, pi hides Luna; log out of `openai` to use the key |
| Jev | `typesafe/jev-latest` | `TYPESAFE_API_KEY` |
| Jev, Clef through OpenRouter | `openrouter/~typesafe/jev-latest`, `openrouter/cloudflare/clef`, `openrouter/cloudflare/clef-flash` | `OPENROUTER_API_KEY` or `/login` |
| Jev, Clef on Workers AI | `cloudflare-workers-ai/typesafe/jev`, `cloudflare-workers-ai/@cf/cloudflare/clef-flash` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| Jev through Vercel or OpenCode | `vercel-ai-gateway/typesafe-ai/jev`, `opencode/jev-1.13` | `AI_GATEWAY_API_KEY`, `OPENCODE_API_KEY` |
| Ollama's cloud models | `ollama/clef:cloud` (with an `ollama` classifier provider, see [Ollama](classifier-ollama.md)) | Ollama 0.40.5+ signed in, a paid plan or credits |

## Setup

1. Set the credential (for example `export OPENAI_API_KEY=...` before starting pi).
2. Add to `~/.pi/agent/pi-switchboard.json`; no `classifierProviders` entry is needed for pi's built-in providers:

   ```json
   "classifiers": [{ "model": "openai/gpt-6-luna", "allowRemote": true, "timeoutMs": 3000, "threshold": 0.8 }]
   ```

3. In pi: `/reload`, then `/tier doctor` (it answers? how fast?), then `/tier eval openai/gpt-6-luna` to choose the threshold.

## Notes

- **Latency.** A hosted call adds a network round trip. Keep `timeoutMs` within `classification.decisionBudgetMs` (4 s by default); `/tier doctor` warns when a classifier is slower than the budget.
- **A local first, a cloud second.** `classifiers` are tried in order within one decision, so a local classifier can come first and a hosted one catch its failures.
- **Cost.** Every routed request makes one classifier call. The provider bills it; pi-switchboard does not cap it.
- **Through a proxy.** A local proxy such as LiteLLM can serve Luna and Jev on `/v1/systemone` too, but pi-switchboard then counts the classifier as local by its address; see [other servers](classifier-other-servers.md).
