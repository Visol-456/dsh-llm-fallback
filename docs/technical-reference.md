# Technical reference

This document is for users and maintainers who need the implementation details: the complete configuration fields, routing and circuit semantics, session event payloads, known limitations, settings-UI implementation notes, and dsh profile deployment and patch diagnostics. For a quick start, see the [README](../README_en.md).

中文版本：[technical-reference.zh.md](technical-reference.zh.md)

## 1. Compatibility and package layout

| Item | Value |
| --- | --- |
| Plugin version | `0.2.0` |
| Compatible DeepSeek Harness | `0.2.0-rc.2` (every `peerDependencies` entry is aligned to it) |
| cordis | `~4.0.4` |
| cordis-plugin-loader | `~1.0.5` |
| schemastery | `~3.18.4` (runtime dependency) |

Not verified against any other dsh version. dsh `0.2.0-rc.1` → `rc.2` only moved official subpackage versions and internal implementation: no public type surface this plugin consumes changed in a breaking way (`dsh-api-remotes/client` adds one `export type {}`; `dsh-client-ui-primitives` adds `MenuGroup` and turns `Input` into a `forwardRef`; everything else is byte-identical), so no source change was needed: the settings seam still reads this plugin's `Volatile` Config fields and the browser half still binds through `ctx.configForms`.

The package declares `dsh.bundle`, pointing at the shipped `cordis.patch.yml`, so `dsh plugin add` mounts the plugin as a profile layer automatically (with no fallbacks, dormant). It has two halves:

- Server half: `src/index.ts` (routing and circuit wiring), `src/circuit.ts` (the pure state machine), `src/types.ts` (event payload types), `src/invariant.ts` (invariant checks).
- Browser half: `src/client/index.ts` (configuration-page registration), `src/client/FallbackBundleConfig.tsx` (the form), `src/client/store.ts` (settings-transport adapter).

## 2. Configuration fields

All keys are top-level; there is no `chains` / `match`. The config is validated by `resolveConfig` before the circuit is built.

| Field | Default | Meaning |
| --- | --- | --- |
| `fallbacks` | none (omitted = dormant) | Ordered `(provider, model)` backup targets a failed request switches through. At least one when present; entries must not repeat a `(provider, model)` pair, and `provider`/`model` must be non-empty strings. |
| `switchCodes` | `EMPTY_RESPONSE, RATE_LIMIT, SERVER, UNKNOWN_MODEL, TIMEOUT, TRANSPORT` | Failure codes eligible to switch; other codes never switch. Must not be empty, must not repeat, and every element must be a non-empty string. |
| `failureThreshold` | `1` | Consecutive eligible failures on the head (or one fallback) that open the circuit; a failed cooldown probe always opens it. Must be a positive safe integer. |
| `cooldownMs` | `0` | How long the head (or that fallback) stays excluded after a switch before it may be probed again. Must be a finite number within `0..2147483647` (the ceiling is `MAX_TIMER_DELAY_MS`). |

Other rules:

- Omitting `fallbacks` entirely is valid and keeps the plugin dormant: every request passes through untouched. Writing an empty array is an error (at least one entry when present).
- Unknown keys error; the old keys `chains` / `match` / `providers` error with a deprecation and migration hint (see section 6).
- Invalid non-empty configuration fails loud at plugin load (both the schema and the cross-field rules are checked). Values written through the settings form are gated by the Config schema; the cross-field rules a schema cannot express (duplicate entries, empty `switchCodes`, ...) are re-checked on live updates, where the plugin refuses the update, keeps the last valid configuration, and logs a warning.
- Resolution order is **schema defaults → composition layer (bundle / `cordis.yml`) → profile patch**, so form saves win and fields never written fall back to defaults.

> Set `cooldownMs` to at least `30000`. With the default `0`, every request probes the head first, so during an outage each request fails once on the head before being served by the fallback.

## 3. Routing and circuit semantics

- **The head is the request itself**: the provider/model the user selected in the harness UI, or the deployment default. The plugin never rewrites the head; every request that fails with a switchable code retries on the same global `fallbacks` list, in order.
- **Attribution**: a failed request is charged only when the serving provider matches and the failure code is in `switchCodes`. The switch marker is pinned to the exact `(agent, turn, step)`, so only the retried request that consumed a switch is ever served by a fallback target.
- **Opening the circuit**: when the head's consecutive count reaches `failureThreshold` (or a cooldown probe fails), the same request is retried on `fallbacks[0]`; each subsequent fallback failure advances to the next one.
- **Cooldown and probing**: during the head's cooldown every request still tries the head first (it is never rewritten); a switchable head failure retries directly on the fallback currently in service (the event `reason` is `probe`).
- **Termination**: the last fallback never switches; its failures stay terminal and surface normally.
- **Recovery**: a successful response resets the serving entry's consecutive count and clears its cooldown marker, so the threshold accumulates from zero again after recovery.
- **No wrapping of `ctx.llm.stream()`**: every adapter call remains one provider attempt, and every chain attempt opens a fresh numbered turn over the same durable history.
- **Config rewriting on a switch**: only `provider`/`model` are replaced; `reasoningEffort` is dropped (it resolves against the head model's capability, and the switched adapter re-resolves its own defaults), while every other provider-neutral field rides along unchanged.
- **Composition with llm-retry**: the waterfall order is retry first, then fallback; a provider whose retry policy is `always` retries everything itself, so fallback never sees its failures.

## 4. Session events

Both events are durable session events and never surface to the model.

`llm/fallback` — appended on every switch.

| Field | Description |
| --- | --- |
| `turn` / `step` | Turn and step of the failed request that triggered the switch. |
| `headProvider` / `headModel` | Provider / model of the chain head. |
| `fromProvider` / `fromModel` | Entry the chain moved away from. |
| `toProvider` / `toModel` | Entry that will serve the retried request. |
| `reason` | `threshold` (consecutive failures reached the limit) or `probe` (re-opened after a failed cooldown probe). |
| `failure` | The failure facts that triggered the switch. |
| `cooldownMs` | Cooldown in milliseconds applied to that entry when service moved away. |

`llm/fallback-route` — appended for every request actually served by a fallback target.

| Field | Description |
| --- | --- |
| `turn` / `step` | Turn and step of the routed request. |
| `headProvider` / `headModel` | Provider / model of the head of the request that triggered routing. |
| `provider` / `model` | Entry that actually serves this request. |

## 5. Known limitations

- **Single global fallback list.** All requests share one `fallbacks` list; failures are charged per serving `(provider, model)`, and a success on one agent never clears another agent's pending count.
- **State is process-local.** The active entry, cooldowns, and consecutive counts reset on restart, so a restarted deployment re-probes from the head; the durable events allow post-hoc audit but do not reconstruct live state.
- **Only agent-loop requests participate.** Direct `ctx.llm.stream()` consumers remain single-provider.
- **Always-mode retry never delegates.** A provider whose retry policy is `always` retries everything itself, so fallback never sees its failures.

## 6. Historical compatibility

- **Config shape (0.1.x).** The config used to be `chains[]` with a per-chain `providers` (0.1.0) or `match` + `fallbacks` (earlier 0.1.1 snapshots). All of that is gone: the head is always the request itself, so only the top-level `fallbacks` list (plus the switch rules) is needed. Migrate `chains: [{ match: { provider: A.provider, model: A.model }, fallbacks: [B, C] }]` to `fallbacks: [B, C]`. Loading any of the old `chains`/`match`/`providers` keys fails with a clear deprecation error.
- **Browser-half inject (fixed in 0.1.8).** The client half must declare both `'remote'` and `'remote.session'`. Cordis resolves every mounted Remote namespace as a service of its own, so with only `'remote'` declared the `api.session.modelCatalog()` property access throws and the whole configuration body fails to render (the card page appears blank). Regression test: `tests/client-inject.spec.ts`.
- **Configuration entry moved (0.2.0).** The Fallback configuration moved from a standalone section inside the Settings dialog to the bundle card page on the Plugins page, through the same mechanism the official plugins' configuration pages use.

## 7. Settings-UI implementation notes

- The configuration form is registered by the **server half** through `ctx.configForms.whileServed`; it only exists when the profile actually mounts this plugin into the composed config tree. If only the client half made it into the page (you can see the package name in `__DSH_BOOT__.entries`) while the server half is not mounted, the card still appears in the **Installed** list but opening it shows no configuration controls — that is a deployment problem, not a source problem (diagnose with section 8).
- The form is keyed by the profile entry id, and this plugin's `id` must stay `llm-fallback` (matching the `cordis.patch.yml` this package ships). Mounted under another id the routing still works, but the web page reports itself unavailable.
- The Plugins page keys the `plugins.bundle.config` slot by the **npm package name** (`@visol-456/dsh-llm-fallback`), which is not the cordis entry id.
- **Honest placeholders while unselected**: a fresh row shows "Select a provider / Select a model" and never fakes the first catalog entry as selected; the provider dropdown lists only routes that are actually usable (i.e. have a loaded model list), labelled by display name, so dormant pi-ai catalog routes and lookalike provider names cannot confuse. Selecting a provider refreshes its model list, and a provider with exactly one model adopts it right away, so the row is immediately savable.
- Reads and writes ride the harness settings transport itself (`ctx.configForms` for reads, `settings.describe|mutate` for writes); the plugin serves no HTTP endpoint of its own, and whether a remote (non-loopback) page may write is the harness settings layer's decision.
- Saved values persist to the active profile's entry configuration (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) and take effect on the **next request** (no restart). A form edit is a volatile-only config update: the Loader commits the new values into the running config references and notifies the plugin, which rebuilds the circuit on `loader/volatile-update`.
- **Restore defaults** clears the four fields the form saved (`fallbacks`, `switchCodes`, `failureThreshold`, `cooldownMs`) and restores the composition layer and schema defaults.
- If another window or document changed the configuration, the page shows a conflict banner and asks you to reload before re-applying; a refused write is classified as `conflict`, `rejected`, or `transport`.
- Form validation mirrors the node schema: at least one fallback target, non-empty and non-duplicate provider/model, a non-empty `switchCodes`, a threshold that is an integer ≥ 1, and a cooldown that is an integer within `0..2147483647`.

## 8. Deployment and patch diagnostics

### A. `dsh plugin add` (recommended)

```bash
dsh plugin --profile web add @visol-456/dsh-llm-fallback
```

The package declares `dsh.bundle`, so installing it activates the plugin as a profile layer with no patch file needed — the shipped `cordis.patch.yml` mounts it with no fallbacks, and targets are created from the UI. Check `$DSH_HOME/profiles/<profile>/package.json`: the package must appear both in `dependencies` and in the **`dsh.profile.bundles`** array (declaring only the client bundle, or only installing the dependency, is not enough).

### B. Manual patch overlay

The overlay file is a **patch list** (not a bare entry list), applied with `--patch`:

```yaml
# cordis.yml
- insert:
    - id: llm-fallback
      name: '@visol-456/dsh-llm-fallback'
```

```bash
dsh web --patch ./cordis.yml
```

That is the **mount-a-new-row** form. When the bundle already mounted the plugin (`dsh plugin add`), writing its configuration takes an `id`-targeted **override** patch instead (no `insert`) — the same shape the settings form writes to the profile's own patch layer:

```yaml
# Override the config of an already mounted row (no insert)
- id: llm-fallback
  config:
    fallbacks:
      - provider: pi-ai
        model: glm-4.5
```

Patch syntax points:

- Every mount entry needs an `id`, and this plugin's `id` must stay `llm-fallback` (the settings form is keyed by that profile entry id).
- New entries must sit under a top-level `- insert:` list (see `examples/web-schedule/cordis.yml` in the harness).
- A bare entry list is silently rejected with `patch: id is required for non-insert patches` / `entry "xxx" not found`, and **`dsh web` prints no startup error** (only `dsh web: http://...`).
- Diagnose the composed tree (and any patch errors):

  ```bash
  dsh --profile web --dump-config | grep -i llm-fallback
  # or, from the harness source:
  node --import tsx/esm apps/cli/src/bin.ts web --dump-config --patch <file>
  ```

  No output means the profile layer never mounted this plugin.

### Local development (unpublished checkout)

Install the local checkout into the profile: dsh installs it as a profile dependency (pnpm `link:`) and appends the bundle to `dsh.profile.bundles`.

```bash
dsh plugin --profile web add /absolute/path/to/dsh-llm-fallback
```

Bundle names in `dsh.profile.bundles` are resolved by `resolveBundleDir()` in the order **dsh installation → profile directory** (the source iterates `for (const anchor of [installAnchor, join(profileDir, 'package.json')])` in `packages/boot/app-boot/src/profile.ts`): a bundle carried by the installation always resolves from the running dsh installation, and only an out-of-tree plugin absent from the installation falls through to the profile directory and is resolved from the profile's own `node_modules`. A local checkout must therefore be installed into the profile with `dsh plugin add` first, then mounted by package name.

### Install and dependency notes

- **Do not re-mount `llm-retry`.** The web profile's base bundle already ships `@deepseek-ai/dsh-llm-retry`; mounting it again duplicates the retry layer. Mount only `llm-fallback`.
- **pnpm supply-chain policy.** Newly published packages (less than 24 h old) are blocked by pnpm's `minimumReleaseAge` (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`), and a failed `pnpm add` can touch the official repo's `pnpm-workspace.yaml` (restore it with `git restore pnpm-workspace.yaml`). For same-day installs, either wait 24 h or use the local-checkout install above.

## 9. Repository development

Build, test, and typecheck commands live in [CONTRIBUTING.md](../CONTRIBUTING.md).
