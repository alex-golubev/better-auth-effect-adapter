# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`better-auth-effect` is a [Better Auth](https://better-auth.com) database adapter for [@effect/sql](https://effect.website/docs/sql). It allows using any Effect SQL provider (PostgreSQL, MySQL, SQLite) with Better Auth by bridging Better Auth's adapter interface with Effect's SQL client.

## Commands

```bash
pnpm build              # Build with tsup (ESM + CJS + .d.ts)
pnpm test               # Run unit tests (vitest run, src/**/*.test.ts)
pnpm test:integration   # Run e2e tests (e2e/**/*.test.ts, needs Docker for PG/MySQL)
pnpm test:all           # Run both unit + e2e tests
pnpm test:watch         # Run tests in watch mode
pnpm typecheck          # Type-check without emitting (tsc --noEmit)
pnpm lint               # ESLint on src/
pnpm lint:fix           # ESLint with auto-fix
pnpm format             # Prettier on src/
pnpm format:check       # Prettier check
```

Run a single test file: `pnpm vitest run src/errors.test.ts`

Run a single e2e test: `pnpm vitest run --config vitest.integration.config.ts e2e/sqlite.test.ts`

## Architecture

The adapter uses `createAdapterFactory` from `better-auth/adapters` (same pattern as Drizzle adapter). The factory handles field name mapping, input/output transforms, and ID generation. The custom adapter just needs to implement CRUD via `@effect/sql` tagged template literals.

Unlike ORM-based adapters (Drizzle), this adapter builds raw SQL because `@effect/sql` is a thin SQL layer, not an ORM. This means the adapter must handle WHERE clause building, RETURNING strategies, and value conversions itself.

### Source modules (`src/`)

- **adapter.ts** — Main entry point. `effectSqlAdapter()` creates the adapter. Uses `createAdapterFactory` with a `createCustomAdapter` closure that accepts an `EffectRunner` (abstracts normal vs transactional execution). Each method builds SQL, runs via `runAdapterEffect`, returns a Promise.

- **where-builder.ts** — Builds SQL WHERE clause fragments from Better Auth's `Where` conditions. Supports all operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`, `contains`, `starts_with`, `ends_with`. Groups by connector (AND/OR) and combines them. LIKE patterns are escaped to prevent wildcard injection.

- **returning.ts** — Dialect-specific `ReturningStrategy` for INSERT/UPDATE. PostgreSQL and SQLite use native `RETURNING *`. MySQL emulates it with `LAST_INSERT_ID()` + SELECT (wrapped in transactions).

- **transforms.ts** — Value conversions: `convertToSqlValue` (Date→ISO string, boolean→0/1, objects→JSON), `toSqlData` (batch convert for INSERT/UPDATE), `getAffectedRows` (extract row count from driver-specific results).

- **query-builder.ts** — SQL fragment builders: `buildSelectColumns`, `buildOrderBy`, `buildLimitOffset` (uses `sql.literal()` for MySQL compatibility), `requireWhereClause`.

- **join-builder.ts** — JOIN resolution via IN-clause batch queries. Supports one-to-one, one-to-many, many-to-many relations. Avoids N+1 by collecting join keys and executing one query per joined table.

- **errors.ts** — Error hierarchy using `Data.TaggedError`: `AdapterError`, `ConstraintViolationError`, `ConnectionError`. `mapSqlError` classifies errors by pattern-matching messages. `runAdapterEffect` bridges Effect → Promise.

- **types.ts** — Shared types: `EffectSqlAdapterConfig`, `Dialect`, `Primitive`, `SqlData`.

### Key patterns

- All database operations flow through `runAdapterEffect` which bridges Effect → Promise for Better Auth's async adapter interface.
- Transaction support: captures the Effect runtime inside `sql.withTransaction`, creates a new `EffectRunner` that runs effects in the transactional context, then builds a new adapter factory for the callback.
- The `lazyOptions` pattern (same as Drizzle adapter): options aren't available at factory creation time, so they're captured when the adapter function is first called.

### E2E tests (`e2e/`)

E2e tests use `runAdapterTest` from `better-auth/adapters/test` which runs 27 standard adapter tests. Each dialect test creates tables manually (can't use better-auth's migration system since it uses Kysely internally).

- **sqlite.test.ts** — Uses `@effect/sql-sqlite-node` with `:memory:`, no Docker needed.
- **postgres.test.ts** — Uses `@testcontainers/postgresql` + `@effect/sql-pg`. Column names need double-quoting (`"emailVerified"`).
- **mysql.test.ts** — Uses `@testcontainers/mysql` + `@effect/sql-mysql2`. No quoting needed for column names.

All three tests require `email_address` column on `user` table for the `FIND_MODEL_WITH_MODIFIED_FIELD_NAME` test.

## Code Style

- No semicolons, single quotes, trailing commas, 120 char print width (see `.prettierrc`).
- ESLint enforces `consistent-type-imports` (use `import type` for type-only imports).
- Unused vars must be prefixed with `_`.
- Peer dependencies: `better-auth`, `effect`, `@effect/sql` (externalized in tsup build).

## Dialect-specific gotchas

- **MySQL**: `mysql2` prepared statements don't support parameterized `LIMIT ?` / `OFFSET ?` — use `sql.literal(String(limit))` instead.
- **MySQL**: No native `RETURNING` — must use `LAST_INSERT_ID()` + SELECT, wrapped in transaction.
- **SQLite**: `better-sqlite3` only accepts numbers, strings, bigints, buffers, null — Date must be converted to ISO string, boolean to 0/1.