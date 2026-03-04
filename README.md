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

### Next.js App Router with Effect Layers

```typescript
// lib/auth.ts
import { Effect, Layer } from "effect"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { HttpApp } from "@effect/platform"
import { effectSqlAdapter } from "better-auth-effect"
import { betterAuth } from "better-auth"

const DatabaseLive = PgClient.layer({
  url: "postgresql://postgres:password@localhost:5432/myapp",
})

const AuthLive = Layer.scoped(Auth, Effect.gen(function* () {
  const rt = yield* Effect.runtime<SqlClient.SqlClient>()
  return betterAuth({
    database: effectSqlAdapter({ runtime: rt, dialect: "pg" }),
  })
})).pipe(Layer.provide(DatabaseLive))

const AuthAppLayer = Layer.mergeAll(AuthLive, DatabaseLive)

const { handler } = HttpApp.toWebHandlerLayer(authHttpApp, AuthAppLayer)

// app/api/auth/[...all]/route.ts
export const GET = (request: Request) => handler(request)
export const POST = (request: Request) => handler(request)
```

## Configuration

```typescript
interface EffectSqlAdapterConfig {
  /**
   * Runtime that provides SqlClient.
   * Obtain via Effect.runtime<SqlClient>() inside a Layer,
   * or from await ManagedRuntime.make(layer).runtime().
   */
  runtime: Runtime.Runtime<SqlClient>

  /**
   * Database dialect for SQL differences (RETURNING clause, etc.)
   * - "pg": PostgreSQL
   * - "mysql": MySQL
   * - "sqlite": SQLite
   */
  dialect: "pg" | "mysql" | "sqlite"

  /**
   * Enable debug logging for adapter operations.
   * @default false
   */
  debugLogs?: boolean
}
```

## Why Runtime?

The adapter accepts an Effect `Runtime` — a lightweight handle that carries the environment (connection pool, services) needed to run effects. By obtaining the `Runtime` inside a Layer, you naturally share the same connection pool between Better Auth and your Effect application code without managing lifecycle manually.

## Database Support

| Database   | Dialect    | RETURNING Support |
|------------|------------|-------------------|
| PostgreSQL | `"pg"`     | Native            |
| SQLite     | `"sqlite"` | Native (3.35+)    |
| MySQL      | `"mysql"`  | Emulated*         |

\* MySQL doesn't support `RETURNING`. The adapter uses `LAST_INSERT_ID()` + SELECT as a fallback. **Tables must have an `id` column as primary key.** This is not a problem for Better Auth, which always uses `id`.

## Column Naming (snake_case / camelCase)

Better Auth uses camelCase field names (`emailVerified`, `accessToken`). If your database uses snake_case columns (`email_verified`, `access_token`), configure transformation in `PgClient.layer`:

```typescript
import { PgClient } from "@effect/sql-pg"

const snakeToCamel = (str: string) =>
  str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())

const camelToSnake = (str: string) =>
  str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

const SqlLive = PgClient.layer({
  database: "myapp",
  // Transform column names automatically
  transformResultNames: snakeToCamel,  // DB → JS (snake_case → camelCase)
  transformQueryNames: camelToSnake,   // JS → DB (camelCase → snake_case)
})
```

This is configured once at the client level and applies to all queries automatically.

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
