# @visol-456/dsh-llm-fallback

English | [中文](README.zh.md)

A provider fallback chain plugin for DeepSeek Harness: when the primary provider fails, the same request is automatically retried on the next configured `(provider, model)` entry, so a rate-limited, timing-out, or temporarily down provider never ends a turn.

> Community plugin for the DeepSeek Harness `dsh-plugin` ecosystem. Not part of the official repository.

## Why

Due to well-known reasons, DeepSeek is going to raise its prices. As a student, I can no longer afford it directly, so I have no choice but to turn to opencode-go. However, opencode-go's connections are very unstable,even with a proxy, it doesn't work well. During long-running tasks, it often gets interrupted due to errors, and when a single provider is deployed, it fails outright if the service is unstable.

- rate limits and quota errors
- server errors and 5xx spikes
- timeouts and transport-level failures

Instead of failing the turn, this plugin keeps a priority-ordered list of `(provider, model)` routes per chain, tracks consecutive switchable failures (a circuit breaker), and automatically fails the request over to the next healthy entry. Later requests keep using the current serving entry until its cooldown expires and a probe back to the chain head succeeds.

## Quick start

```bash
npm i @visol-456/dsh-llm-fallback
```

Mount the plugin in your `cordis.yml`:

```yaml
- name: '@visol-456/dsh-llm-fallback'
  config:
    chains:
      - providers:
          - provider: deepseek-official
            model: deepseek-v4-flash
          - provider: pi-ai
            model: glm-4.5
        switchCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, UNKNOWN_MODEL, TIMEOUT, TRANSPORT]
        failureThreshold: 1
        cooldownMs: 30000
```

`chains` is optional: an empty (or missing) list is valid and keeps the plugin dormant. Every request passes through untouched until you save chains from the Settings -> Fallback page in the web UI.

## Deploying to the web profile (dsh web)

### A. `dsh plugin add` (recommended)

The package declares `dsh.bundle`, so installing it activates the plugin as a profile layer automatically (no patch file needed -- the shipped `cordis.patch.yml` mounts the plugin with no chains, and you create chains from the UI):

```bash
dsh plugin --profile web add @visol-456/dsh-llm-fallback
```

### B. Manual patch overlay

Create an overlay file (a patch list, not a bare entry list) and apply it with `--patch`:

```yaml
# cordis.yml
- insert:
    - id: llm-fallback
      name: '@visol-456/dsh-llm-fallback'
```

```bash
dsh web --patch ./cordis.yml
```

### Patch syntax (the most common pitfall)

- Every mount entry needs an `id`.
- New entries must sit under a top-level `- insert:` list (see `examples/web-schedule/cordis.yml` in the harness).
- A bare entry list is silently rejected with `patch: id is required for non-insert patches` / `entry "xxx" not found`, and **`dsh web` prints no startup error** (only `dsh web: http://...`).
- Diagnose the composed tree (and any patch errors) with:

  ```bash
  node --import tsx/esm apps/cli/src/bin.ts web --dump-config --patch <file>
  ```

### Local development junction

`$DSH_HOME/profiles/node_modules` is the launcher-maintained bundle fallback and does not participate in bare plugin resolution from the harness source. To mount an unpublished checkout, junction it into the **harness checkout's own `node_modules`**:

```powershell
New-Item -ItemType Junction -Path 'E:\python_programs\deepseek-harness\node_modules\@visol-456\dsh-llm-fallback' -Target 'E:\python_programs\llm-fallback'
```

Then mount it by name as above. Remove the junction when you no longer need it.

### Do not re-mount llm-retry

The web profile's base bundle already ships `@deepseek-ai/dsh-llm-retry`; mounting it again duplicates the retry layer. Mount only `llm-fallback` -- the waterfall order (retry first, then fallback) is correct by construction.

### pnpm supply-chain policy

Newly published packages (less than 24 h old) are blocked by pnpm's `minimumReleaseAge` (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`), and a failed `pnpm add` can touch the official repo's `pnpm-workspace.yaml` -- restore it with `git restore pnpm-workspace.yaml`. For same-day installs, either wait 24 h or use the junction approach above.

### Port already in use

If `dsh web` will not start (or the browser hits the old instance), find and kill the stale process:

```powershell
netstat -ano | findstr :3080
taskkill /PID <pid> /F
```

## Configuration

- `chains` (optional, default `[]`): independent chains, each keyed on its head entry. An empty list disables routing (requests pass through untouched); create chains from the Settings -> Fallback page or write them to `<DSH_HOME>/settings.yaml`. Chains must not share any `(provider, model)` entry, so a request always matches at most one chain.
- `providers` (required, at least two, inside a chain): ordered `(provider, model)` service entries; entries must not repeat within a chain.
- `switchCodes` (default `EMPTY_RESPONSE, RATE_LIMIT, SERVER, UNKNOWN_MODEL, TIMEOUT, TRANSPORT`, covering transient failures and the configuration-error class): failure codes eligible to switch. Other codes never switch.
- `failureThreshold` (default 1): consecutive eligible failures on the serving entry that open the circuit. A failed cooldown probe always opens it.
- `cooldownMs` (default 0): how long a switched-away entry stays excluded before it may be probed again.

> **Recommendation:** set `cooldownMs` to at least `30000`. With the default `0`, every request probes the head first, so during an outage each request fails once on the head before being served by the fallback.

Invalid non-empty configuration fails loud at plugin load (or at write time when saved through the settings seam).

## How it works

- Each chain lists two or more `(provider, model)` entries in priority order; the first entry is the chain head that requests are keyed on.
- A failed request is charged to the chain that routed it, and only when the serving entry's provider served it and the failure code is in `switchCodes`.
- When the consecutive count reaches `failureThreshold` (or a cooldown probe fails), the circuit opens and the same request is retried on the next entry.
- A successful response resets the serving entry's count and clears its cooldown, so the threshold accumulates from zero again after recovery.
- The last entry never switches; its failures stay terminal and surface normally.
- The plugin does not wrap `ctx.llm.stream()`: every adapter call remains one provider attempt, and every chain attempt opens a fresh numbered turn over the same durable history.

## Events

Both events are durable session events and never surface to the model.

- `llm/fallback` — appended on every switch. Payload: `turn`, `step`, `headProvider`, `headModel`, `fromProvider`, `fromModel`, `toProvider`, `toModel`, `reason` (`threshold` | `probe`), `failure`, `cooldownMs`.
- `llm/fallback-route` — appended for every request actually served by a non-head entry. Payload: `turn`, `step`, `headProvider`, `headModel`, `provider`, `model`.

## Known limitations

- **Provider-level attribution.** Failures are charged to the chain that routed the request, keyed on exact `(provider, model)` entries: chains that share a provider under different models can neither switch nor reset each other, and requests no chain routed charge nothing.
- **State is process-local.** The active entry, cooldowns, and consecutive counts reset on restart, so a restarted deployment re-probes from the head; the durable events allow post-hoc audit but do not reconstruct live state.
- **Only agent-loop requests participate.** Direct `ctx.llm.stream()` consumers remain single-provider.
- **Always-mode retry never delegates.** A provider whose retry policy is `always` retries everything itself, so fallback never sees its failures.

## Web UI configuration (dsh web)

The same chains can be edited from the harness web UI without touching `cordis.yml`. When the plugin is loaded in the `dsh web` profile, a **Fallback** page appears under Settings (next to Models):

- With no chains configured, the page shows a guided empty state: "Add your first chain". The first chain you save takes effect on the next request.
- Edit chains: add/remove/reorder `(provider, model)` entries, switch codes, failure threshold, and cooldown, then **Save**.
- Saved values persist to `<DSH_HOME>/settings.yaml` and take effect on the **next request** (no restart). Resolution order is schema defaults -> your `cordis.yml` entry -> the saved UI section, so UI saves win and fields absent from `cordis.yml` fall back to defaults.
- **Reset to cordis.yml** clears the saved section and restores pure `cordis.yml` behavior (or dormant mode when the entry has no chains).
- If another window or the settings document changed the configuration, the page shows a conflict banner and asks you to reload before re-applying.

The browser reads and writes the section through a loopback-only endpoint (`/llm-fallback/config`) served by the plugin on the shared web server. The endpoint rejects non-loopback peers and cross-site requests; it is a miswrite/cross-site fence, not an authentication layer. When the web server is bound to `0.0.0.0`, LAN clients cannot write, but do not expose the endpoint to untrusted networks.

## License

MIT
