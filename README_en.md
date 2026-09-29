# @visol-456/dsh-llm-fallback

[English](README_en.md) | [中文](README.md)

A provider fallback chain plugin for DeepSeek Harness: when the primary provider fails, the same request is automatically retried on the next configured `(provider, model)` target, so a rate-limited, timing-out, or temporarily unavailable provider no longer ends a turn.

> Community plugin for the DeepSeek Harness `dsh-plugin` ecosystem. Not part of the official repository.
>
> Current plugin version **0.2.0**, compatible with DeepSeek Harness **0.2.0-rc.2** (`peerDependencies` are aligned to that release; cordis `~4.0.4`, schemastery `~3.18.4`; not verified against any other dsh version).

## What it does

- The request itself is always the head (the provider/model you select in the UI, or the deployment default) and is never rewritten; only a failed retry switches to a fallback target.
- A failed request switches through the top-level `fallbacks` in order; the last fallback never switches and its failure surfaces normally.
- Consecutive eligible failures on the head or a fallback open the circuit; during the cooldown every request still tries the head first, and a failed probe always switches again.
- With no fallbacks configured the plugin stays dormant and every request passes through untouched; saving your first target takes effect on the next request, with no restart.
- Every switch, and every request actually served by a fallback target, is written as a durable session event (never surfaced to the model).
- Composes with the base bundle's `@deepseek-ai/dsh-llm-retry` by waterfall order: mount only `llm-fallback`, do not mount a second `llm-retry`.

Full routing semantics, field rules, and event payloads live in the [technical reference](docs/technical-reference.md).

## Install and minimal working configuration

```bash
dsh plugin --profile web add @visol-456/dsh-llm-fallback
```

The package declares `dsh.bundle`, so installing it activates the plugin as a profile layer automatically; the shipped `cordis.patch.yml` mounts it with **no fallbacks** (dormant). Then create fallback targets from the web UI:

sidebar **Plugins** → the **llm-fallback** card under **Installed** → open the card page → add fallback targets with the provider/model dropdowns, adjust switch codes / failure threshold / cooldown → **Save**.

For manual mounting or configuration through `cordis.yml`, see the [technical reference](docs/technical-reference.md).

## What the plugin page offers

- Per-row fallback editing: linked provider/model dropdowns plus in-row move up / move down / remove; the provider dropdown lists only routes that are actually usable and have a loaded model list, labelled by display name.
- Switch codes (wide input), failure threshold, and cooldown are edited in the same form; saving writes to the active profile's entry configuration and takes effect on the next request.
- **Restore defaults** clears the four fields the form saved and returns the entry to the composition layer and schema defaults.
- If the configuration changed elsewhere, the page shows a conflict banner and asks you to reload before re-applying.

## Documentation

- [Technical reference (English)](docs/technical-reference.md) / [技术参考（中文）](docs/technical-reference.zh.md): full config fields, routing and circuit semantics, event payloads, known limitations, settings-UI implementation notes, dsh profile bundle activation and patch diagnostics.
- [Contributing (English)](CONTRIBUTING.md) / [贡献指南（中文）](CONTRIBUTING.zh.md).

## License

MIT
