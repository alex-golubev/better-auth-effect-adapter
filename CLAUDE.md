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

- **Write functional, declarative Effect code.** Imperative code is not acceptable in `src/` or `test/`:
  - Don't use `throw`, `try`/`catch`, `let`, loops (`for`/`while`), `switch`, mutation (`push`/`splice`/assignment), or `if` statements.
  - `Effect.try` is allowed only to wrap third-party code that throws (for example better-auth's `getFieldName`), mapping the failure to a typed error. Never use it around our own code; make our code fail as a value instead.
  - Errors are values. Fail with typed errors (`Effect.fail`, `Effect.filterOrFail`, `Effect.fromOption` + `mapError`), and keep the error type in the signature.
  - Use `Option` instead of null/undefined checks.
  - Branch on a dialect (or another closed set) with lookup tables like `Record<Dialect, …>`. Use `Match` for multi-way branching on values or types. Ternaries are fine for simple two-way expressions.
  - Use `effect`'s `Array`/`Option`/`Order`/`Predicate` and `pipe`. Use `Effect.forEach`/`Effect.all` instead of looping with `yield*`.
  - Escape hatches exist only at the boundaries:
    - better-auth's Promise interface: run effects with `Effect.runPromiseWith`;
    - the synchronous `fromContext`: `Effect.runSync` on top of the Effect-based `make`.
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
- `effect/sql` and the `@effect/sql-*` drivers are marked `@stability unstable`, so they may break between minor versions. They are allow-listed in `tsconfig.json` (`allowedUnstableApis`).
- `@effect/sql-pg` caches prepared statements per connection by SQL text (`prepare: true` by default). If a table is recreated with different column types on a live pool, the cached parameter types go stale (`operator does not exist: uuid = text`). The test harness uses `prepare: false` for this reason.
- The DDL generator (`src/schema.ts`) is also what integration tests use to build schemas. `test/harness.ts` → `resetSchema(options)` drops all tables and recreates them.
- SQLite (`node:sqlite`): `Date` and plain objects can't be bound as parameters.
