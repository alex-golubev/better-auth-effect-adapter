# Contributing

## Setup

You need Node.js 22 or later, pnpm 10 (`corepack enable`), and Docker for the integration tests.

```bash
pnpm install   # also patches TypeScript with @effect/tsgo (the `prepare` script)
```

| Command                 | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `pnpm typecheck`        | TypeScript, with the Effect rules of `@effect/tsgo` as errors    |
| `pnpm check`            | Biome lint and format (`pnpm check:fix` applies fixes)           |
| `pnpm test`             | Unit tests (`src/**/*.test.ts`)                                  |
| `pnpm test:integration` | Integration tests on SQLite, PostgreSQL and MySQL (needs Docker) |
| `pnpm test:bun`         | Smoke test under Bun (needs Bun)                                 |
| `pnpm build`            | ESM build into `dist/`                                           |

## Code

- **Effect style.** Write functional, declarative Effect code: no `if`, `throw`, `try`/`catch`, `let`, loops or mutation. Errors are typed values. `pnpm typecheck` enforces the Effect-native and anti-pattern rules (native `Array`/`String` methods, `Date`, `JSON`, `async` functions, `Effect.provide` outside entry points and more).
- **Comments** explain why, in a line or two. Don't restate the code.
- **Tests.**
  - Write them with `@effect/vitest`.
  - Unit tests sit next to the code, integration tests in `test/`.
  - Behaviour that depends on the database belongs in an integration test that runs on all three.
- **Commits.** Use a prefix: `feat:`, `fix:`, `docs:`, `test:`, `chore:` or `style:`.

## Pull requests

`main` is protected. Changes go through a pull request, which merges once every CI job passes (Node 22/24/26, integration tests, Bun) and the branch is up to date with `main`.

## Releasing

Maintainers only:

1. Open a pull request with one commit `X.Y.Z` that sets the version in `package.json` and dates its section in `CHANGELOG.md`.
2. Merge it with a rebase, so the commit keeps its name.
3. Tag the merged commit `vX.Y.Z` and push the tag. Release tags can't be moved or deleted.

The release workflow then checks, builds and publishes to npm with provenance, and creates the GitHub release from the changelog.
