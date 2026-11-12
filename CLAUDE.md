# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: full rewrite in progress (branch `rewrite`)

`better-auth-effect` is a [Better Auth](https://better-auth.com) database adapter for Effect SQL (`effect/sql`). Version 1.0 is being rewritten from scratch for **effect 4.1+** and **better-auth 1.7+**. The old 0.4.x code (effect 3, better-auth 1.5) lives on `main` only. Both libraries changed a lot, so verify APIs against the installed packages rather than memory.

## Commands

```bash
pnpm build              # tsdown, ESM only → dist/index.mjs + index.d.mts
pnpm typecheck          # tsc (TypeScript 7, patched by @effect/tsgo for Effect diagnostics)
pnpm check              # Biome lint + format check (pnpm check:fix to apply)
pnpm test               # vitest project "unit"        (src/**/*.test.ts)
pnpm test:integration   # vitest project "integration" (test/**/*.test.ts; PG/MySQL need Docker)
pnpm test:all           # both
```

To run a single file: `pnpm vitest run src/where.test.ts` or `pnpm vitest run test/sqlite.test.ts`.

## Layout

- `src/` holds the library. Unit tests sit next to the code as `*.test.ts`.
- `test/` holds integration tests. They run the official `@better-auth/test-utils` suites against SQLite (in-memory), plus PostgreSQL and MySQL via testcontainers.

## Code style

- Biome (`biome.json`): 2-space indent, 120 columns, single quotes, no semicolons, trailing commas.
- Use `import type` for type-only imports.
- Unused variables are errors.
- TypeScript is strict, with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- Peer dependencies are `effect` and `better-auth`. Drivers are dev-only.

## Key facts

- effect 4 has no `Runtime`. Capture a `Context` (`Effect.context()`) and run it with `Effect.runPromiseWith(ctx)`. A rejected promise carries the original error instance.
- Detect the dialect with `sql.onDialectOrElse`; don't ask the user for it.
- `.raw` skips `transformQueryNames`. Compile first, then run `sql.unsafe(q, p).raw` to get row counts.
- `sql('col')` is an Identifier, not a Fragment, so wrap it as `` sql`${sql('col')}` `` inside `sql.and`/`sql.or`. Note that `sql.or([])` compiles to `1=1`.
- In better-auth 1.7, `select` and `sortBy` arrive as logical names; map them with `getFieldName({ model: modelKey, field })`. `in`/`not_in` arrays are never value-converted by the factory.
- Inside an app transaction, adapter calls must run on the caller's context via the ALS bridge. On the root context they deadlock on SQLite and escape the transaction on PG/MySQL. This is GitHub issue #4.
- MySQL: `LIMIT` and `OFFSET` go through `sql.literal`. There is no `RETURNING`; emulate it inside a transaction.
- SQLite (`node:sqlite`): `Date` and plain objects can't be bound as parameters.
