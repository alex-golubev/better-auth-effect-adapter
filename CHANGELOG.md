# Changelog

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
