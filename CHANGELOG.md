# Changelog

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
