# Changelog

## 0.4.1 (2026-03-05)

### Bug Fixes

- Allow `deleteMany` with empty WHERE clause (required by `testAdapter` cleanup to delete all rows from a table)

### Tests

- Rewrite all e2e tests (SQLite, PostgreSQL, MySQL) using `testAdapter` and a shared `createTestSuite`-based test suite with 31 adapter test cases
- Add smoke tests (`e2e/smoke.test.ts`) that run through the full `betterAuth()` stack — signUp, signIn, getSession — to catch API contract changes between better-auth versions
- Identifier transform tests (camelToSnake/snakeToCamel) preserved as standalone vitest blocks

## 0.4.0 (2026-03-04)

### Breaking Changes

- **Replace `ManagedRuntime` with `Runtime` in adapter config** — `effectSqlAdapter()` now accepts `Runtime.Runtime<R>` instead of `ManagedRuntime.ManagedRuntime<R, E>`. Obtain a `Runtime` via `Effect.runtime<SqlClient.SqlClient>()` inside a Layer, or from `await ManagedRuntime.make(layer).runtime()`.
- Remove unused generic parameter `E` from `EffectSqlAdapterConfig<R, E>` → `EffectSqlAdapterConfig<R>`

### Documentation

- Update README usage example to Next.js App Router with Effect Layers
- Update Configuration section to reflect `Runtime` API

## 0.3.3 (2026-02-16)

### Bug Fixes

- Fix `updateMany` and `deleteMany` bypassing SQL client identifier transforms (e.g. `camelCase → snake_case`) — `.raw` on tagged templates internally calls `compile(withoutTransform=true)`, skipping `transformQueryNames`; now uses `compileAndExecuteRaw` helper that compiles first (preserving transforms), then executes raw via `sql.unsafe` for row count extraction

### Tests

- Add row count tests for `updateMany` and `deleteMany` across all three dialects
- Add identifier transform tests (`transformQueryNames: camelToSnake`) for `updateMany` and `deleteMany` across all three dialects — these tests fail without the fix (`no such column`)

## 0.3.2 (2026-02-12)

### Bug Fixes

- Fix MySQL `LIKE` query generation by using explicit `ESCAPE '!'` and dialect-safe pattern escaping for `contains`, `starts_with`, and `ends_with`
- Fix `IN` / `NOT IN` value handling by normalizing array members through `convertToSqlValue` (including `boolean[]` -> `0/1` and `Date[]` -> ISO strings)
- Prevent secondary teardown failures in PostgreSQL/MySQL e2e tests when container startup fails by guarding `runtime.dispose()` and container shutdown

### Tests

- Add unit regression tests for `where-builder` covering `IN` with `boolean[]` and `Date[]`
- Add unit regression coverage for `LIKE ... ESCAPE` generation and escaping of special characters (including the escape character itself)
- Add SQLite e2e regression tests for `IN` filters with boolean and date values

## 0.3.1 (2026-02-12)

### Refactoring

- Standardize SQL value conversion in `where-builder` for consistent handling across operators
- Refine `LIKE` operator implementation and related tests
- Minor test suite cleanup in `where-builder` specs

## 0.3.0 (2026-02-09)

### Bug Fixes

- Fix SQLite: `better-sqlite3` rejects `Date` and `boolean` values — now converted to ISO string and 0/1 in `convertToSqlValue`
- Fix MySQL: `mysql2` prepared statements don't support parameterized `LIMIT ?` / `OFFSET ?` — now inlined as SQL literals

### Features

- Add `join-builder` module with `resolveJoins` for `one-to-one`, `one-to-many`, and `many-to-many` relations
- Add e2e integration tests for all three dialects (SQLite, PostgreSQL, MySQL) using `runAdapterTest` from `better-auth/adapters/test`
- PostgreSQL and MySQL tests use `@testcontainers` for automatic Docker container lifecycle
- Add GitHub Actions CI with unit tests (Node 20/22/24) and integration tests, with `workflow_dispatch` for manual runs

### Refactoring

- Extract `transforms.ts` (data conversion: `getAffectedRows`, `convertToSqlValue`, `toSqlData`)
- Extract `query-builder.ts` (SQL fragment builders: `buildSelectColumns`, `buildOrderBy`, `buildLimitOffset`, `requireWhereClause`)
- Rewrite `convertToSqlValue` using Effect `Match` pattern matching
- Move e2e tests to `e2e/` directory (`sqlite.test.ts`, `postgres.test.ts`, `mysql.test.ts`)

### Tests

- 240 total tests (159 unit + 81 e2e across 3 dialects)
- Add unit tests for `transforms.ts`, `query-builder.ts`, `join-builder.ts`
- Add additional edge-case tests for `where-builder` (LIKE escaping, non-array IN/NOT IN)
- Add cause extraction tests for `mapSqlError`

## 0.2.1 (2026-01-23)

- Update dependencies and lockfile

## 0.2.0 (2026-01-22)

- Add `groupByConnector` logic for WHERE clause building with unit tests
- Add comprehensive unit tests for SQL adapter utilities, error handling, and query builders
- Enhance SQL adapter with safe JSON conversion, SQL pattern escaping, and improved annotations
- Return affected row counts for update and delete operations
- Refactor SQL adapter with modular query building and improved error handling
- Refactor `where-builder.test.ts` for cleaner code and consistency
- Fix repository URLs in `package.json`
- Clarify MySQL `id` column requirement in README

## 0.1.0 (2026-01-22)

- Initial release
- Effect SQL adapter for Better Auth (`effectSqlAdapter`)
- Support for PostgreSQL, MySQL, and SQLite dialects
- Dialect-specific returning strategies (native `RETURNING *` for PostgreSQL/SQLite, `LAST_INSERT_ID()` emulation for MySQL)
- WHERE clause builder with support for `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`, `contains`, `starts_with`, `ends_with` operators
- Error hierarchy: `AdapterError`, `ConstraintViolationError`, `ConnectionError`
- Bridge between Effect and Better Auth's Promise-based adapter interface via `runAdapterEffect`
