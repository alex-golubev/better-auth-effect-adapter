# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`better-auth-effect` is a [Better Auth](https://better-auth.com) database adapter for [@effect/sql](https://effect.website/docs/sql). It allows using any Effect SQL provider (PostgreSQL, MySQL, SQLite) with Better Auth by bridging Better Auth's adapter interface with Effect's SQL client.

## Commands

```bash
pnpm build          # Build with tsup (ESM + CJS + .d.ts)
pnpm test           # Run all tests (vitest run)
pnpm test:watch     # Run tests in watch mode
pnpm typecheck      # Type-check without emitting (tsc --noEmit)
pnpm lint           # ESLint on src/
pnpm lint:fix       # ESLint with auto-fix
pnpm format         # Prettier on src/
pnpm format:check   # Prettier check
```

Run a single test file: `pnpm vitest run src/errors.test.ts`

## Architecture

The adapter accepts a `ManagedRuntime` (providing `SqlClient`) and a dialect, then implements all Better Auth adapter methods (`create`, `findOne`, `findMany`, `update`, `updateMany`, `delete`, `deleteMany`, `count`).

### Source modules (`src/`)

- **adapter.ts** — Main entry point. `effectSqlAdapter()` creates the adapter via `createAdapterFactory` from `better-auth/adapters`. Each method builds SQL using `@effect/sql` tagged template literals, runs the Effect through `runAdapterEffect`, and returns a Promise. Helper functions handle value conversion (`toSqlData`), WHERE condition mapping (`toWhereConditions`), and SQL fragment building (columns, ORDER BY, LIMIT/OFFSET).

- **where-builder.ts** — Builds SQL WHERE clause fragments from Better Auth's `Where` conditions. Supports operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`, `contains`, `starts_with`, `ends_with`. Groups conditions by connector (AND/OR) and combines them.

- **returning.ts** — Dialect-specific `ReturningStrategy` for INSERT/UPDATE operations. PostgreSQL and SQLite use native `RETURNING *`. MySQL emulates it with `LAST_INSERT_ID()` + SELECT (wrapped in transactions).

- **errors.ts** — Error hierarchy using Effect's `Data.TaggedError`: `AdapterError`, `ConstraintViolationError`, `ConnectionError`. `mapSqlError` classifies `SqlError` instances by pattern-matching error messages. `runAdapterEffect` runs an Effect via `ManagedRuntime.runPromise`, catching errors and converting them via `Effect.die`.

- **types.ts** — Shared types: `EffectSqlAdapterConfig`, `Dialect`, `Primitive`, `SqlData`.

- **index.ts** — Public API re-exports.

### Key patterns

- All database operations flow through `runAdapterEffect` which bridges Effect → Promise for Better Auth's async adapter interface.
- The code uses functional Effect patterns extensively: `pipe`, `Option`, `Effect.gen`, `Data.TaggedError`.
- Tests are unit-only and don't require a database. Where internal functions aren't exported, tests re-implement the logic locally.

## Code Style

- No semicolons, single quotes, trailing commas, 120 char print width (see `.prettierrc`).
- ESLint enforces `consistent-type-imports` (use `import type` for type-only imports).
- Unused vars must be prefixed with `_`.
- Peer dependencies: `better-auth`, `effect`, `@effect/sql` (externalized in tsup build).