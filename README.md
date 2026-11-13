# better-auth-effect

[![npm](https://img.shields.io/npm/v/better-auth-effect)](https://www.npmjs.com/package/better-auth-effect)
[![CI](https://github.com/alex-golubev/better-auth-effect-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-golubev/better-auth-effect-adapter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/better-auth-effect)](./LICENSE)

A [Better Auth](https://better-auth.com) database adapter for [Effect SQL](https://effect.website) (`effect/sql`), for PostgreSQL, MySQL and SQLite.

- **One connection pool.** Better Auth runs on your app's `SqlClient`, so it uses your pool and your layers.
- **Your transactions.** Auth calls made inside your `sql.withTransaction` commit and roll back with it.
- **No extra configuration.** The dialect is detected from the client.
- **Fewer queries.** `consumeOne` and `incrementOne` are a single statement, and joins take one query per joined table.
- **Schema generation.** `npx auth generate` writes the SQL schema for your database.

## Requirements

| Dependency  | Version                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| effect      | 4.1 or later                                                                                            |
| better-auth | 1.7 or later                                                                                            |
| Runtime     | Node.js 22 or later, or Bun                                                                             |
| Driver      | `@effect/sql-pg`, `@effect/sql-mysql2` (MySQL 8), `@effect/sql-sqlite-node` or `@effect/sql-sqlite-bun` |

The package is ESM only.

- **Coming from 0.x (Effect 3)?** See the migration guide in the [changelog](./CHANGELOG.md).
- **Stability.** Effect marks `effect/sql` and the `@effect/sql-*` drivers as unstable, so their APIs may change between minor versions of Effect.

## Installation

```bash
pnpm add better-auth-effect better-auth effect @effect/sql-pg
```

Replace `@effect/sql-pg` with the driver for your database.

## Usage

### In an Effect application

Build Better Auth inside a service. `EffectSqlAdapter.make()` takes the `SqlClient` from the context, so auth uses the same client as the rest of your app.

```ts
import { PgClient } from '@effect/sql-pg'
import { betterAuth } from 'better-auth'
import { EffectSqlAdapter } from 'better-auth-effect'
import { Config, Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

export class Auth extends Context.Service<Auth>()('app/Auth', {
  make: Effect.gen(function* () {
    const database = yield* EffectSqlAdapter.make()
    const auth = betterAuth({ database, emailAndPassword: { enabled: true } })
    return { ...EffectSqlAdapter.bind(auth), handler: auth.handler }
  }),
}) {}

export const SqlLive = PgClient.layerConfig({ url: Config.Redacted('DATABASE_URL') })

// Auth and the rest of the app share SqlLive, and with it one pool.
export const AppLive = Layer.effect(Auth, Auth.make).pipe(Layer.provideMerge(SqlLive))
```

Call Better Auth through `use`. It works inside your transactions too:

```ts
export const signUpWithWorkspace = (email: string, password: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const auth = yield* Auth
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { user } = yield* auth.use((api) => api.signUpEmail({ body: { email, password, name: email } }))
        yield* sql`INSERT INTO workspace ${sql.insert({ ownerId: user.id, name: 'Personal' })}`
        return user
      }),
    )
  })
```

If the insert fails, the new user is rolled back with it.

### In a Promise application (Next.js and others)

Capture a context from a `ManagedRuntime`, and run your own database code on the same runtime:

```ts
import { PgClient } from '@effect/sql-pg'
import { betterAuth } from 'better-auth'
import { toNextJsHandler } from 'better-auth/next-js'
import { EffectSqlAdapter } from 'better-auth-effect'
import { Effect, ManagedRuntime, Redacted } from 'effect'
import { SqlClient } from 'effect/sql'

const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL ?? '') }))

export const auth = betterAuth({
  database: EffectSqlAdapter.fromContext(await runtime.context()),
  emailAndPassword: { enabled: true },
})

export const { GET, POST } = toNextJsHandler(auth)

// App code runs on the same runtime, so on the same pool.
export const countUsers = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT COUNT(*) AS n FROM "user"`))
```

`fromContext` is the synchronous form of `make`. It throws `EffectSqlAdapterError` when the client's dialect isn't supported.

### Mounting the handler on an Effect HTTP router

Continuing the `Auth` service from the Effect example above:

```ts
import { Effect, Layer } from 'effect'
import { HttpEffect, HttpRouter } from 'effect/http'

export const AuthRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* Auth
    return HttpRouter.add('*', '/api/auth/*', HttpEffect.fromWebHandler(auth.handler))
  }),
)
```

## One connection pool

Better Auth doesn't open connections of its own. Every auth query goes through the `SqlClient` the adapter was created with, so all you need is to build that client once.

Effect memoizes a layer by reference within one memo map. Whether two places end up with the same client depends on how the layer is built:

| How the layer is built                                                          | One pool? |
| ------------------------------------------------------------------------------- | --------- |
| One `SqlLive` value used throughout one layer graph                             | Yes       |
| `PgClient.layer(config)` called twice                                           | No        |
| Two `ManagedRuntime.make(SqlLive)`                                              | No        |
| Two `ManagedRuntime.make(..., { memoMap })` sharing `Layer.makeMemoMapUnsafe()` | Yes       |

For example, take a pool of 5 under 200 concurrent `getSession` calls plus app queries. PostgreSQL saw at most 5 connections with one shared layer, and 10 with two runtimes that each had their own layer.

## Auth calls inside your transactions

Better Auth's API returns Promises, so the adapter can't see the Effect fiber that called it, and with it any open transaction. Wrapping an auth call in `Effect.promise` or `Effect.tryPromise` inside `sql.withTransaction` therefore goes wrong:

- **SQLite:** it hangs forever, because the transaction holds the only connection ([#4](https://github.com/alex-golubev/better-auth-effect-adapter/issues/4)).
- **PostgreSQL and MySQL:** auth queries run on another pooled connection, outside your transaction, so a rollback doesn't undo them. With a pool of one connection, it deadlocks.

Use `EffectSqlAdapter.run` or `EffectSqlAdapter.bind` instead:

```ts
yield* sql.withTransaction(
  Effect.gen(function* () {
    yield* sql`INSERT INTO audit_log ${sql.insert({ event: 'sign-up' })}`
    yield* EffectSqlAdapter.run(() => auth.api.signUpEmail({ body }))
  }),
)

// Or bind the instance once:
const bound = EffectSqlAdapter.bind(auth)
yield* bound.use((api) => api.signUpEmail({ body }))
yield* bound.handler(request) // auth.handler, as an Effect
```

How `run` and `bind` behave:

- **Context.** `run` hands the current Effect context, including an open transaction, to the adapter through `AsyncLocalStorage`. Outside a transaction, it simply runs on the current context.
- **Nested transactions.** Better Auth's own transactions, such as the one in sign-up, become savepoints inside yours.
- **Errors.** They fail with `AuthCallError`, whose `cause` is the original rejection, such as Better Auth's `APIError`. Catch it with `Effect.catchTag('AuthCallError', …)`.
- **Other databases.** The caller's context is only used when it holds the adapter's own `SqlClient`. A call made from the context of a different database still goes to the adapter's database.

Caveats:

- **After hooks run before your commit.** Hooks such as `databaseHooks.user.create.after` run when Better Auth's own transaction ends, which is before your transaction commits, and a rollback doesn't undo them. A hook that sends an email will send it even if you roll back afterwards.
- **Background tasks can outlive your transaction.** With `advanced.backgroundTasks.handler` configured, work that Better Auth starts in the background inside `run` may outlive your transaction. Its queries after that point fail with "the transaction has already ended". Without a handler, Better Auth awaits that work, so it stays inside your transaction.

## Schema

```bash
npx auth generate --output schema.sql
```

The CLI asks the adapter for the schema (the default file is `better-auth-schema.sql`). The adapter writes `CREATE TABLE` and `CREATE INDEX` statements for your database. These follow:

- your `modelName` and `fields` settings;
- `advanced.database.generateId` (`'serial'` or `'uuid'`);
- your plugins;
- the client's `transformQueryNames`.

Things to know:

- **Applying it.** Apply the file with your migration tool, for example the `effect/sql` migrator. `npx auth migrate` only works with Better Auth's built-in Kysely adapter.
- **No diffs.** The output always describes the whole schema. When you add a plugin later, compare it with your database by hand.

## Column names (snake_case)

There are two ways to use different column names:

- Better Auth's own `modelName` and `fields` options, which work everywhere.
- The driver's name transforms, which also apply to the adapter's queries:

```ts
import { PgClient } from '@effect/sql-pg'
import { Redacted, String as Str } from 'effect'

const SqlLive = PgClient.layer({
  url: Redacted.make(process.env.DATABASE_URL ?? ''),
  transformQueryNames: Str.camelToSnake,
  transformResultNames: Str.snakeToCamel,
  transformJson: false,
})
```

With driver transforms:

- **Keep Better Auth's names in camelCase**, for example `fields: { email: 'emailAddress' }` and not `'email_address'`. Results come back through `transformResultNames`, so a column named `email_address` would arrive as `emailAddress`.
- **PostgreSQL:** set `transformJson: false`. Otherwise the keys inside `jsonb` columns are renamed when read.
- **MySQL:** there is no such option, so the keys inside JSON columns are renamed.
- **Schema generation** applies `transformQueryNames`, so `npx auth generate` produces the snake_case schema.

## Errors

- **Database errors** reach Better Auth, and your code, unchanged: as `SqlError` from `effect/sql`, classified by `reason`.

  ```ts
  import { SqlError } from 'effect/sql'

  const isDuplicate = (error: unknown) => SqlError.isSqlError(error) && error.reason._tag === 'UniqueViolation'
  ```

- **`EffectSqlAdapterError`** is for the adapter's own failures:
  - an unsupported dialect (`make` and `fromContext` reject MSSQL and ClickHouse);
  - an unknown field in `select` or `sortBy`;
  - an invalid `limit` or `offset`;
  - a schema that can't be generated.

## Performance

Queries per call, as measured with this adapter:

| Call          | Default               | `session.cookieCache.enabled`     |
| ------------- | --------------------- | --------------------------------- |
| `getSession`  | 2                     | 0 until the cached cookie expires |
| `signInEmail` | 3                     | 3                                 |
| `signUpEmail` | 4, in one transaction | 4                                 |

- **`cookieCache` is the biggest saving.** `getSession` runs on every request, and with the cache enabled it reads the session from a signed cookie.
- **Joins.** With `advanced.database.joins: true`, Better Auth asks the adapter for related rows together with the main query. The adapter loads them with one `IN` query per joined table, whatever the number of rows, and applies the per-parent limit in SQL. Reading many rows with their relations then costs one query plus one per joined table, instead of one per row. Single-row lookups such as `getSession` stay at 2.
  - The join queries run one after another, so a join never takes extra connections from the pool.
- **`consumeOne` and `incrementOne`** are a single `DELETE` or `UPDATE … RETURNING` on PostgreSQL and SQLite. On MySQL, see below.

## Database notes

### PostgreSQL

- **Ids.** uuid ids come from the database (`gen_random_uuid()`), and serial ids are identity columns.
- **`bigint` columns** come back as JS numbers, like Better Auth's other number fields. Values above `Number.MAX_SAFE_INTEGER` lose precision.
- **Schema changes on a running app.** `@effect/sql-pg` caches prepared statements per connection. If a migration changes a column's type while the app is running, cached statements fail, for example with `operator does not exist: uuid = text`. Restart the app, or recreate the pool, after such migrations.

### MySQL

- **Time zone.** Set the driver's time zone to UTC. mysql2 reads and writes dates in the process's local time zone by default, which shifts timestamps whenever the time zone differs between writes and reads. `MysqlClient` ignores `poolConfig` when given a `url`, so put it in the URL:

  ```ts
  MysqlClient.layer({ url: Redacted.make('mysql://user:password@localhost:3306/app?timezone=Z') })
  ```

- **No `RETURNING`.** The adapter reads a written row back by its id. `update`, `consumeOne` and `incrementOne` first lock the matching rows with `SELECT … FOR UPDATE` inside a transaction, which becomes a savepoint inside yours.
- **Case.** Case-sensitive comparisons (the default `mode`) bind the value with `COLLATE utf8mb4_bin`, so they distinguish case with any column collation and still use the column's index. `mode: 'insensitive'` compares with `LOWER()`. The connection needs the `utf8mb4` character set, which is mysql2's default.
- **Schema changes on a running app.** MySQL is worse than PostgreSQL here. After a table is recreated with different column types, cached prepared statements can silently read nothing. Restart the app after such migrations, or use `disablePreparedStatements: true`.
- **Dates** are `datetime(3)`, which has no year-2038 limit.

### SQLite

- **Drivers.** Works with `@effect/sql-sqlite-node` (`node:sqlite`) and `@effect/sql-sqlite-bun`.
- **Types.** Dates are stored as ISO strings, and booleans as `0` and `1`.
- **One connection.** There is a single connection, so inside a transaction always call auth through `run` or `bind`.

## Options

```ts
EffectSqlAdapter.make({ debugLogs: true })
```

`debugLogs` is passed to Better Auth's adapter factory.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Report security issues privately, as described in [SECURITY.md](./SECURITY.md).

## License

MIT
