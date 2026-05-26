# pi-oauth

Install with pi:

```bash
pi install npm:pi-oauth
```

`pi-oauth` is a small collection of supplemental OAuth/subscription-backed providers for pi. These are extension-provided integrations, not official pi built-in providers. It only includes integrations that can be kept narrow, explicit, and user-controlled.

Provider modules:

- `xai` — ready: `xAI Grok`, subscription OAuth, models, and optional tools.
- `cursor` — ready: Cursor subscription browser OAuth, streaming through Cursor's native AgentService protocol, with live subscription model discovery.

Sign in:

```text
/login
```

Choose **Use a subscription**, then choose **xAI Grok** or **Cursor**.

Cursor opens `cursor.com/loginDeepControl`, polls Cursor auth, then discovers the models available to your subscription.

## Commands

```text
/oauth
/xai
/cursor
```

`/oauth` shows available pi-oauth providers and login guidance.

`/xai` manages xAI-specific options.

`/cursor` shows Cursor auth status. `/cursor refresh-models` refreshes and persists the live subscription model list after login.

## Cursor models

Registered models include:

- `cursor/auto`
- `cursor/composer-2.5`
- `cursor/composer-2.5-fast`
- `cursor/claude-4.6-sonnet`
- `cursor/claude-4.7-opus`
- `cursor/gpt-5.3-codex`
- `cursor/gpt-5.5`
- `cursor/gemini-3.1-pro`
- `cursor/gemini-3.5-flash`
- `cursor/grok-4.3`

After subscription login, pi-oauth calls Cursor's native AgentService `GetUsableModels` endpoint and stores the discovered model list with the OAuth credentials. The chat path streams directly from Cursor AgentService, without a localhost proxy, yielding `text_delta` chunks inline as they arrive — no per-turn buffering, so the model's tokens reach the pi UI the moment Cursor emits them. By default it uses the Cursor CLI-style HTTP/2 `/agent.v1.AgentService/Run` bidi stream; set `PI_CURSOR_H2_BIDI=0` to fall back to the HTTP/1.1 RunSSE/BidiAppend path. Mid-stream drops are recovered via Cursor's checkpoint Resume action with suffix-prefix overlap dedup against the unprotected window between the last checkpoint and the error, so a Resume that replays already-streamed text is collapsed back into a single clean answer without losing real-time streaming. Cursor tool requests are translated into pi tool calls so pi can run and display tools normally. Cursor conversation checkpoint reuse is enabled by default for normal follow-up turns; set `PI_CURSOR_CONVERSATION_CACHE=0` to force full pi-context replay for debugging. Tool-result turns use Cursor's native same-bridge continuation by default; set `PI_CURSOR_ACTIVE_TOOLS=0` to force pi-context replay. Pi's system prompt is mapped into Cursor `RequestContext.rules` / `non_file_rules`, matching Cursor's supported Rules mechanism for system-level Agent instructions. `RequestedModel` metadata is sent with Cursor requests; `PI_CURSOR_MAX_MODE=1` explicitly opts into Cursor max mode. Override advanced settings with `CURSOR_API_URL`, `CURSOR_CLIENT_VERSION`, or `CURSOR_DEFAULT_MODEL`.

Cursor AgentService protocol code in `src/cursor-agent/` is derived from/reconciled against MIT-licensed Cursor protocol research, especially `Yukaii/yet-another-opencode-cursor-auth`, and validated against the local `cursor-agent` CLI bundle.

## xAI models

Registered models:

- `xai-grok/grok-4.3`
- `xai-grok/grok-4.20-0309-reasoning`
- `xai-grok/grok-4.20-0309-non-reasoning`
- `xai-grok/grok-build-0.1`
- `xai-grok/grok-code-fast-1`

## xAI tools

Tools are disabled by default. Enable or disable them with:

```text
/xai
```

Available tools:

- `search_x_posts` — search public X.com/Twitter posts with Grok's server-side X search.
- `generate_xai_image` — generate one Grok Imagine image and save it as a local JPEG file.

The `/xai` menu also shows the Grok usage page:

```text
https://grok.com/?_s=usage
```
