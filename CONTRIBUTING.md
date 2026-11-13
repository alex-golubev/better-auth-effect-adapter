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

## Releasing

Maintainers only:

1. Set the version in `package.json` and date its section in `CHANGELOG.md`.
2. Commit that as `X.Y.Z`.
3. Push the tag `vX.Y.Z`.

The release workflow then checks, builds and publishes to npm with provenance, and creates the GitHub release from the changelog.
