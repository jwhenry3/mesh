# mesh

[![CI](https://github.com/jwhenry3/mesh/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/jwhenry3/mesh/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/jwhenry3/mesh/graph/badge.svg?branch=master)](https://codecov.io/gh/jwhenry3/mesh)

Typed shared-memory worker pools for TypeScript — deterministic `SharedArrayBuffer`
layouts, first-class task methods, and cross-thread reactive state.

## Packages

| Package | What it is |
|---|---|
| `@jwhenry123/mesh` | Core SDK — `defineWorker`/`connectWorker` typed worker clients over `WorkerPool`, shared-memory contracts, `watch`/`observe`, codecs |
| `@jwhenry123/mesh-react` | React hooks — `useObservable`, `useSharedValue`, `useTask` |
| `@jwhenry123/mesh-vue` | Vue composables — `useObservable`, `useSharedValue`, `useTask` |
| `@jwhenry123/mesh-solidjs` | Solid primitives — `createObservable`, `createSharedValue`, `createTask` |
| `@jwhenry123/mesh-svelte` | Svelte 5 rune bindings — `observableValue`, `sharedValue`, `taskState` |
| `@jwhenry123/mesh-angular` | Angular signals — `observableSignal`, `sharedValue`, `taskState` |
| `@jwhenry123/mesh-nextjs` | Next.js client-component bindings (React re-export) |
| `@jwhenry123/mesh-node` | `node:worker_threads` runtime adapter |
| `@jwhenry123/mesh-nestjs` | NestJS module/decorators for worker pools |
| `@jwhenry123/mesh-worker-dom` | worker-side React reconciler + proxy DOM islands — opt-in DOM rendering |
| `@jwhenry123/mesh-react-island` | React shell components for worker-dom islands — `<Island/>`, `islandComponent`, `lazyIsland` |

Framework bindings are published independently — install only the one you use:

```bash
npm install @jwhenry123/mesh @jwhenry123/mesh-react
```

## Documentation

Full docs deploy to GitHub Pages on every push to `master`:
[jwhenry3.github.io/mesh](https://jwhenry3.github.io/mesh/) —
`/sdk/` is the internals/SDK site (source: `docs/`), `/consumer/` the
package-usage site (source: `docs-consumer/`).

## Releasing

Create a GitHub Release tagged `v<semver>` — `.github/workflows/publish.yml`
runs the full test suite, builds the core `dist`, stamps every publishable
package at the tag's version (lockstep; `packages/incidents` stays private),
and **stages** each to npm with provenance. Staged versions aren't
installable until a maintainer approves them — `npm stage list` /
`npm stage approve <stage-id>` (2FA at approval, not in CI), or the Staged
Packages tab on npmjs.com. Requires a granular `NPM_TOKEN` repo secret.
Preview the plan locally: `node scripts/publish.mjs v0.1.0 --dry-run`.

Staging needs each package to already exist on the registry, so the first
release is a manual bootstrap — from the repo root:

```bash
npm login                                    # once
npm ci && npx vite build && npx tsc -p tsconfig.build.json
node scripts/publish.mjs 0.1.0 --direct      # prompts for 2FA per package
```

Once all nine packages exist, release-driven `npm stage publish` works for
every subsequent version.

### Trusted publishing (OIDC)

Prefer OIDC over the `NPM_TOKEN` secret — no long-lived credential, and a
trust relationship can be **stage-only** so the workflow can't direct-publish
even if compromised. Configure per package (needs the package to exist on
npm, and npm CLI ≥ 11.10):

```bash
for p in mesh mesh-node mesh-react mesh-angular mesh-nestjs mesh-nextjs mesh-solidjs mesh-svelte mesh-vue; do
  npm trust github "@jwhenry123/$p" --repo jwhenry3/mesh --file publish.yml --allow-stage-publish -y
  sleep 2
done
```

Omit `--allow-publish` — stage-only. First call prompts for 2FA; choose
"skip for 5 minutes" and the loop finishes hands-free. Verify with
`npm trust list @jwhenry123/mesh`. Once all nine show the relationship,
delete the `NODE_AUTH_TOKEN` env line in `publish.yml` (npm only uses OIDC
when no token is present) — the secret can be revoked after.

## Layout

```
src/sdk/            core SDK — contract/ (shared protocol), pool/, worker/
packages/<fw>/      independently publishable framework bindings
packages/incidents/ demo domain package (contract + worker + pool)
examples/<fw>/      per-framework demo apps
docs/, docs-consumer/  documentation sites
```

## Scripts

```bash
npm test            # vitest — all suites (sdk + packages + example e2e)
npm run build       # typecheck + lib build
npm run dev:all     # launch every example dev server
npm run build:pages # docs + examples → dist-pages (GitHub Pages artifact)
```

Worker demos require cross-origin isolation (COOP/COEP) — the dev servers set it;
GitHub Pages cannot, so embedded live demos there are inert.
