# Changelog

All notable changes to `pi-oauth` are documented here.

## Unreleased

### Fixed

- Cursor AgentService chat now streams `text_delta` chunks inline as Cursor emits them, instead of buffering an entire turn and flushing on `turnEnded`. Mid-stream drops are recovered via Cursor's checkpoint Resume action with a suffix-prefix overlap dedup against the unprotected window between the last checkpoint and the error, so a Resume that replays already-streamed text collapses back into a single clean answer without regressing on duplicates.

## 0.0.1 - 2026-05-24

### Added

- Initial installable pi package for OAuth/subscription-backed providers.
- `xai-grok` OAuth provider for xAI Grok subscription accounts.
- Live-verified Grok language models: `grok-4.3`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-build-0.1`, plus `grok-code-fast-1` alias.
- `/oauth` provider/login guidance command.
- `/xai` management command for xAI status, usage guidance, and optional tools.
- `search_x_posts` and `generate_xai_image`, both disabled by default.
- `cursor` subscription provider with browser OAuth login, direct Cursor AgentService streaming, subscription model discovery, `/cursor` status, and `/cursor refresh-models`.
- Cursor AgentService tool requests are translated into pi tool calls. Normal follow-up turns use Cursor checkpoint conversation reuse by default with full-replay fallback; tool-result turns use Cursor-native same-bridge continuation by default with full-replay fallback available via `PI_CURSOR_ACTIVE_TOOLS=0`.
- Added serialized Cursor `BidiAppend` writes, client heartbeats, and `TurnEndedUpdate` token/cache accounting parsed from Cursor AgentService.
- Aligned Cursor AgentService transport with Cursor CLI: native HTTP/2 `/agent.v1.AgentService/Run` bidi is used by default with HTTP/1.1 RunSSE/BidiAppend as a fallback; Connect headers/body format now match the CLI path and legacy non-CLI checksum headers were removed.
- Cursor requests now include `RequestedModel` metadata alongside `ModelDetails`, with `PI_CURSOR_MAX_MODE=1` available as an explicit opt-in for Cursor max mode.
- Cursor requests map pi system prompts to Cursor `RequestContext.rules` / `non_file_rules`, using Cursor's supported Rules mechanism instead of the hidden `--system-prompt` / AgentRunRequest field 8 path.
- Cursor single-turn prompts now send the raw user request instead of a synthetic transcript, reducing duplicate greeting/final-answer behavior in the TUI; HTTP/2 session errors are also handled to avoid late unhandled `ECONNRESET` crashes.
- Added `test:live:cursor` for Cursor subscription live validation, including first-token latency, prompt replay reduction, real cache-read token counters, and 20-turn tool-call continuity metrics.
