# Contributing

Thanks for considering a contribution to `@visol-456/dsh-llm-fallback`. This is a community plugin for the DeepSeek Harness `dsh-plugin` ecosystem, not part of the official repository.

## Development setup

The repository uses npm (`package-lock.json` is committed).

```bash
npm install
npm run typecheck   # tsc for both the node and the client program
npm test            # vitest run
npm run build       # tsc (node + client) then tsdown
```

- `src/index.ts` and `src/circuit.ts` are the server half (routing and the pure circuit state machine).
- `src/client/*` is the browser half (the Plugins-page configuration form).
- `tests/*.spec.ts` cover the circuit, loader composition, settings transport, and the client half. `tests/client-inject.spec.ts` pins the client `inject` list against every namespace the browser half reads; keep it passing when touching the client.

## Compatibility

`package.json` pins the DeepSeek Harness `peerDependencies` to the version the plugin is verified against (`0.2.0-rc.2`). Do not widen or bump them without verifying the plugin against that harness release.

## Documentation conventions

- `README.md` is the Chinese landing page and `README_en.md` the English one; both are user-facing and must stay in sync and concise.
- Deep technical content belongs in `docs/technical-reference.zh.md` (Chinese) and `docs/technical-reference.md` (English), not in the README.
- Every change to one side of a documentation pair must be mirrored to the other, then the hashes in `README.i18n.yaml` re-recorded:

  ```bash
  git hash-object README.md README_en.md docs/technical-reference.zh.md docs/technical-reference.md CONTRIBUTING.zh.md CONTRIBUTING.md
  ```

- Use repository-relative links (`docs/...`, `../README.md`, ...) so they resolve on GitHub and npm. Verify with `git diff --check` and by checking that each relative link target exists.

## Scope

Pull requests should not include `lib/` (generated), `node_modules/`, or `package-lock.json` churn unrelated to a dependency change. Release, tag, and publish steps are maintainer-only.
