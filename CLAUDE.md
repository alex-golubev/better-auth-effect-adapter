# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: full rewrite in progress (branch `rewrite`)

`better-auth-effect` is a [Better Auth](https://better-auth.com) database adapter for Effect SQL (`effect/sql`). Version 1.0 is being rewritten from scratch for **effect 4.1+** and **better-auth 1.7+**. The old 0.4.x code (effect 3, better-auth 1.5) lives on `main` only. Both libraries changed a lot, so verify APIs against the installed packages rather than memory.

## Commands

```bash
pnpm build              # tsdown, ESM only → dist/index.mjs + index.d.mts (declarations from tsconfig.build.json: src only)
pnpm typecheck          # tsc (TypeScript 7, patched by @effect/tsgo for Effect diagnostics)
pnpm check              # Biome lint + format check (pnpm check:fix to apply)
pnpm test               # vitest project "unit"        (src/**/*.test.ts)
pnpm test:integration   # vitest project "integration" (test/**/*.test.ts; PG/MySQL need Docker)
pnpm test:all           # both
```

To run a single file: `pnpm vitest run src/where.test.ts` or `pnpm vitest run test/sqlite.test.ts`.

## Layout

- `src/` holds the library. Unit tests sit next to the code as `*.test.ts`.
- `test/` holds integration tests. They run against SQLite (in-memory), plus PostgreSQL and MySQL via testcontainers (`test/harness.ts`).
  - `sqlite.test.ts`, `postgres.test.ts`, `mysql.test.ts` run every official `@better-auth/test-utils` suite through `runOfficialSuites` (`test/suites.ts`).
  - `sqlite-snake-case.test.ts` runs them again with the client's name transforms (`camelToSnake` / `snakeToCamel`).
  - `schema.test.ts` checks the generated DDL, `issue-4.test.ts` the app-transaction bridge on all three databases, `operations.test.ts` the guards of `incrementOne`/`consumeOne` under concurrent writes and bigint results, and `pool.test.ts` that auth shares the app's PostgreSQL pool.
- Tests are written with `@effect/vitest`.
  - Test bodies are effects: `it.effect(name, () => Effect.gen(...))`.
  - Shared services come from `layer(...)` blocks. In `src/`, use `buildPerTest: true` when each test needs a fresh SQLite.
  - In `test/`, databases are layers (`sqliteDatabase()`, `postgresDatabase()`, `mysqlDatabase()`: a `Layer<SqlClient>` whose testcontainer stops with the layer). Share them through `withDatabase(layer)`, which is `layer(...)` with `excludeTestServices: true`. Integration tests need the live clock: `TestClock` would freeze the issue #4 deadlock guard (`Effect.timeout`) and the drivers' timers.
  - `test/auth.ts` holds the `Auth` service the integration tests build better-auth with, from `make()`.
  - Each test starts with `yield* resetSchema(options)`. `@effect/vitest`'s `beforeEach` can't require services.
  - Better-auth calls go through `run` / `bind` (inside transactions) or `Effect.promise` (outside them).
  - The official suites are the exception: `@better-auth/test-utils` drives Vitest through a Promise API, so `runOfficialSuites` runs the database layer on a `ManagedRuntime`.

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
- `pnpm typecheck` enforces the rules of `@effect/tsgo`'s `effect-native` and `antipattern` presets as errors (`diagnosticSeverity` in `tsconfig.json`), in `src/` and `test/` alike:
  - no `async` functions or `new Promise`;
  - Effect's `Array`, `String` and `Record` instead of native methods (`.map`, `.join`, `.replace`, `Object.entries`, …);
  - `DateTime`/`Clock` instead of `new Date()`/`Date.now()`;
  - Schema instead of `JSON`;
  - no global `console`, `fetch`, `Math.random`, timers or `process.env`;
  - `Effect.try`/`tryPromise` always with a `catch` that maps to a typed error, no `try`/`catch` in generators;
  - `Effect.provide(layer)` only at entry points. In tests, share layers through `layer(...)` blocks, and build a local one with `Layer.build` + `Effect.provideContext`.
- Import Effect modules by their own names from the barrel: `import { Array, Option, Record, String } from 'effect'`, with no aliases such as `Arr` or `Str`.
  - `preferBarrelImport` (with `barrelImportPackages: ["effect"]`) rejects `effect/Array`-style module imports.
  - Shadowing the globals `Array` and `String` is intended, since the rules above forbid the natives anyway, so Biome's `noShadowRestrictedNames` is off.
  - Type positions still resolve to the global types (`Record<K, V>`, `Array<T>`).
  - Where `String` is imported, convert values with a template literal instead of `String(x)`.
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
  - `src/context.ts` holds the bridge. `run(() => promise)` and `bind(auth).use/handler` put the caller's Effect context into an `AsyncLocalStorage`.
  - The adapter's runner uses that context only when it carries the adapter's own `SqlClient` (`ambientContext`); otherwise it uses the root context.
  - `config.transaction` runs better-auth's callback inside `sql.withTransaction` on that ambient context, so inside an app transaction it becomes a savepoint.
  - `test/issue-4.test.ts` is the regression test.
- MySQL:
  - `LIMIT` and `OFFSET` go through `sql.literal`.
  - There is no `RETURNING` (`returning.mysql` in `src/operations.ts`). Inserts read the row back by id: the one better-auth generated, else `insertId`. `update`, `consumeOne` and `incrementOne` lock the matching rows with `SELECT … FOR UPDATE` inside `sql.withTransaction`, then write and read back by id. MySQL can't `LIMIT` an `IN` subquery.
  - Default collations ignore case, so `sensitive` string comparisons bind the value with `COLLATE utf8mb4_bin` (`src/where.ts`). `=` and `IN` keep the plain comparison too, so the lookup stays an exact index lookup. This works on any schema, including `_ci` columns.
  - mysql2 reads and writes `Date` in the process's local time zone by default. Apps need `timezone: 'Z'`; with a `url`, `MysqlClient` ignores `poolConfig`, so it goes into the URL (`?timezone=Z`). The adapter can't fix this, since the driver parses dates.
- `effect/sql`, the `@effect/sql-*` drivers and `@effect/vitest` are marked `@stability unstable`, so they may break between minor versions. They are allow-listed in `tsconfig.json` (`allowedUnstableApis`).
- Both `@effect/sql-pg` and `@effect/sql-mysql2` use server-side prepared statements by default, cached per connection by SQL text. A cached statement outlives a table recreated with different column types on a live pool.
  - PostgreSQL fails loudly: `operator does not exist: uuid = text`.
  - MySQL 8.4 fails intermittently, depending on which pooled connection still holds the old statement. Inserts fail with "Data too long", updates with "Truncated incorrect DOUBLE value", and reads silently match nothing.
  - The harness option `preparedStatements: false` (PG `prepare: false`, MySQL `disablePreparedStatements: true`) is used by the tests that recreate tables with different id types: the official suites and `schema.test.ts`. The others keep the drivers' default.
- The DDL generator (`src/schema.ts`) is also what integration tests use to build schemas. In `test/harness.ts`, the effect `resetSchema(options)` drops all tables and recreates them.
  - `SchemaConfig.rename` maps better-auth's names to physical ones before index names are computed. `createSchema` and the harness pass `clientNames(sql, dialect)`, the client's own rendering of an identifier, so the DDL follows `transformQueryNames` exactly as queries do.
- Driver name transforms (`transformQueryNames` / `transformResultNames`) work with the adapter, with three caveats:
  - better-auth's own `fields` names must stay round-trip safe (camelCase), since results come back through `transformResultNames`;
  - PostgreSQL needs `transformJson: false`, or keys inside jsonb are renamed on read;
  - MySQL has no such option.
- `README.md` documents user-facing behavior and `CHANGELOG.md` the 0.4 → 1.0 migration. Keep both in sync with behavior changes.
- SQLite (`node:sqlite`): `Date` and plain objects can't be bound as parameters.
- PostgreSQL re-checks only a statement's outer conditions on a row that a concurrent write changed, not a subquery's. `firstMatch` (`consumeOne` / `incrementOne`) therefore repeats the condition outside its `id IN (SELECT … LIMIT 1)`.
- `@effect/sql-pg` returns int8 as a JS BigInt. The adapter turns BigInts in result rows into numbers (`withNumbers` in `src/adapter.ts`).
- Drivers of one dialect report affected rows under different keys (`changes`, `rowCount`, `affectedRows`, `rowsAffected`). `affectedRows` accepts any of them.
- `delete` with an empty `where` deletes nothing. `deleteMany` with an empty `where` clears the table, as the official suites require.
