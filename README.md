# pi-oauth

Install with pi:

```bash
pi install npm:pi-oauth
```

`pi-oauth` is a small collection of supplemental OAuth/subscription-backed providers for pi. These are extension-provided integrations, not official pi built-in providers. It only includes integrations that can be kept narrow, explicit, and user-controlled.

Provider modules:

- `xai` — ready: `xAI Grok`, subscription OAuth, models, and optional tools.
- `cursor` — planned: guidance for official Cursor CLI/API-key auth; no provider is registered yet.

Sign in:

```text
/login
```

Choose **Use a subscription**, then choose **xAI Grok**.

## Commands

```text
/oauth
/xai
/cursor
```

`/oauth` shows available pi-oauth providers and login guidance.

`/xai` manages xAI-specific options.

`/cursor` shows the planned Cursor auth path.

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
