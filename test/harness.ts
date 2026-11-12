import { MysqlClient } from '@effect/sql-mysql2'
import { PgClient } from '@effect/sql-pg'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { MySqlContainer } from '@testcontainers/mysql'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import type { BetterAuthOptions } from 'better-auth'
import { getAuthTables } from 'better-auth/db'
import { type Context, Effect, type Layer, ManagedRuntime, Redacted } from 'effect'
import { SqlClient } from 'effect/sql'
import type { Dialect } from '../src/dialect'
import { idStrategyOf, schemaStatements } from '../src/schema'

/** A database the integration tests run against, plus schema management. */
export interface TestDatabase {
  readonly dialect: Dialect
  readonly context: Context.Context<SqlClient.SqlClient>
  readonly run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>
  /** Drops every table, then creates the schema for `options` with our DDL generator. */
  readonly resetSchema: (options: BetterAuthOptions) => Promise<void>
  readonly dispose: () => Promise<void>
}

const dropTables = (sql: SqlClient.SqlClient, tables: ReadonlyArray<{ readonly name: string }>) =>
  Effect.forEach(tables, ({ name }) => sql`DROP TABLE ${sql(name)}`, { discard: true })

const dropAllTables: Record<Dialect, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  sqlite: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tables = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `
    yield* sql`PRAGMA foreign_keys = OFF`
    yield* dropTables(sql, tables)
    yield* sql`PRAGMA foreign_keys = ON`
  }),
  pg: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP SCHEMA IF EXISTS public CASCADE`
    yield* sql`CREATE SCHEMA public`
  }),
  // FOREIGN_KEY_CHECKS is per session, so everything runs on one pinned connection.
  mysql: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql<{ name: string }>`
          SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
        `
        yield* sql`SET FOREIGN_KEY_CHECKS = 0`
        yield* dropTables(sql, tables)
        yield* sql`SET FOREIGN_KEY_CHECKS = 1`
      }),
    )
  }),
}

const fromLayer = async (
  dialect: Dialect,
  layer: Layer.Layer<SqlClient.SqlClient, unknown>,
  stop: () => Promise<unknown> = async () => {},
): Promise<TestDatabase> => {
  const runtime = ManagedRuntime.make(layer)
  const context = await runtime.context()
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)
  return {
    dialect,
    context,
    run,
    resetSchema: (options) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const statements = yield* schemaStatements(getAuthTables(options), {
            dialect,
            idStrategy: idStrategyOf(options),
          })
          yield* dropAllTables[dialect]
          yield* Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true })
        }),
      ),
    dispose: async () => {
      await runtime.dispose()
      await stop()
    },
  }
}

export const sqliteDatabase = (): Promise<TestDatabase> =>
  fromLayer('sqlite', SqliteClient.layer({ filename: ':memory:' }))

export const postgresDatabase = async (): Promise<TestDatabase> => {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start()
  // The driver caches prepared statements per connection by SQL text. Tests recreate
  // tables with different column types (text/integer/uuid ids) on the same pool, which
  // would leave stale parameter types in that cache ("operator does not exist: uuid = text").
  const layer = PgClient.layer({ url: Redacted.make(container.getConnectionUri()), prepare: false })
  return fromLayer('pg', layer, () => container.stop())
}

export const mysqlDatabase = async (): Promise<TestDatabase> => {
  const container = await new MySqlContainer('mysql:8.4').start()
  return fromLayer('mysql', MysqlClient.layer({ url: Redacted.make(container.getConnectionUri()) }), () =>
    container.stop(),
  )
}
