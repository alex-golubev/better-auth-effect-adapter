# better-auth-effect

A [Better Auth](https://better-auth.com) database adapter for [@effect/sql](https://effect.website/docs/sql).

Use any Effect SQL provider (PostgreSQL, MySQL, SQLite) with Better Auth.

## Installation

```bash
npm install better-auth-effect
# or
pnpm add better-auth-effect
```

### Peer Dependencies

```bash
npm install better-auth effect @effect/sql
```

And one of the database drivers:

```bash
# PostgreSQL
npm install @effect/sql-pg

# MySQL
npm install @effect/sql-mysql2

# SQLite
npm install @effect/sql-sqlite-node
```

## Usage

```typescript
import { ManagedRuntime } from "effect"
import { PgClient } from "@effect/sql-pg"
import { effectSqlAdapter } from "better-auth-effect"
import { betterAuth } from "better-auth"

// 1. Create your database Layer
const SqlLive = PgClient.layer({
  url: "postgresql://postgres:password@localhost:5432/myapp"
})

// Or with individual options:
// const SqlLive = PgClient.layer({
//   host: "localhost",
//   database: "myapp",
//   username: "postgres",
//   password: "password",
// })

// 2. Create a ManagedRuntime
const runtime = ManagedRuntime.make(SqlLive)

// 3. Use the adapter with Better Auth
export const auth = betterAuth({
  database: effectSqlAdapter({
    runtime,
    dialect: "pg",
  }),
  // ... other Better Auth options
})
```

## Configuration

```typescript
interface EffectSqlAdapterConfig {
  /**
   * ManagedRuntime that provides SqlClient.
   * Create with ManagedRuntime.make(YourSqlLayer)
   */
  runtime: ManagedRuntime.ManagedRuntime<SqlClient, never>

  /**
   * Database dialect for SQL differences (RETURNING clause, etc.)
   * - "pg": PostgreSQL
   * - "mysql": MySQL
   * - "sqlite": SQLite
   */
  dialect: "pg" | "mysql" | "sqlite"

  /**
   * Enable debug logging
   * @default false
   */
  debugLogs?: boolean
}
```

## Why ManagedRuntime?

Using `ManagedRuntime` allows you to share the same connection pool between Better Auth and your Effect application code:

```typescript
import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"

// Single Layer for your entire app
const SqlLive = PgClient.layer({ database: "myapp" })

// Single Runtime - shared connection pool
const runtime = ManagedRuntime.make(SqlLive)

// Better Auth uses the same pool
const auth = betterAuth({
  database: effectSqlAdapter({ runtime, dialect: "pg" }),
})

// Your app code uses the same pool
const getUsers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql`SELECT * FROM users`
})

// Run with the same runtime
runtime.runPromise(getUsers)
```

## Database Support

| Database   | Dialect    | RETURNING Support |
|------------|------------|-------------------|
| PostgreSQL | `"pg"`     | Native            |
| SQLite     | `"sqlite"` | Native (3.35+)    |
| MySQL      | `"mysql"`  | Emulated*         |

\* MySQL doesn't support `RETURNING`. The adapter uses `LAST_INSERT_ID()` + SELECT as a fallback. **Tables must have an `id` column as primary key.** This is not a problem for Better Auth, which always uses `id`.

## Supported Operations

All Better Auth adapter methods are implemented:

- `create` - Insert with RETURNING
- `findOne` - SELECT with WHERE, LIMIT 1
- `findMany` - SELECT with WHERE, ORDER BY, LIMIT, OFFSET
- `update` - UPDATE with RETURNING
- `updateMany` - UPDATE multiple rows
- `delete` - DELETE single row
- `deleteMany` - DELETE multiple rows
- `count` - SELECT COUNT(*)

## Error Handling

The adapter maps SQL errors to typed errors:

```typescript
import {
  AdapterError,
  ConstraintViolationError,
  ConnectionError
} from "better-auth-effect"
```

- **ConstraintViolationError** - Unique/foreign key violations
- **ConnectionError** - Database connection issues
- **AdapterError** - Other SQL errors

## License

MIT
