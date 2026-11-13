import { MysqlClient } from '@effect/sql-mysql2'
import { PgClient } from '@effect/sql-pg'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { layer } from '@effect/vitest'
import { MySqlContainer } from '@testcontainers/mysql'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import type { BetterAuthOptions } from 'better-auth'
import { getAuthTables } from 'better-auth/db'
import { Effect, Layer, Redacted, String as Str } from 'effect'
import { SqlClient } from 'effect/sql'
import { type Dialect, dialectOf } from '../src/dialect'
import { clientNames, idStrategyOf, schemaStatements } from '../src/schema'

export type Database = Layer.Layer<SqlClient.SqlClient, unknown>

/** `layer` with the live clock: `TestClock` would freeze timeouts and driver timers. */
export const withDatabase = <R, E>(database: Layer.Layer<R, E>) => layer(database, { excludeTestServices: true })

const dropTables = (sql: SqlClient.SqlClient, tables: ReadonlyArray<{ readonly name: string }>) =>
  Effect.forEach(tables, ({ name }) => sql`DROP TABLE ${sql(name)}`, { discard: true })

const dropAllTables: Record<Dialect, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  sqlite: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tables = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `
    yield* sql`PRAGMA foreign_keys = OFF`
    yield* Effect.ensuring(dropTables(sql, tables), Effect.orDie(sql`PRAGMA foreign_keys = ON`))
  }),
  pg: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP SCHEMA IF EXISTS public CASCADE`
    yield* sql`CREATE SCHEMA public`
  }),
  // FOREIGN_KEY_CHECKS is per session: one pinned connection.
  mysql: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql<{ name: string }>`
          SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
        `
        yield* sql`SET FOREIGN_KEY_CHECKS = 0`
        yield* Effect.ensuring(dropTables(sql, tables), Effect.orDie(sql`SET FOREIGN_KEY_CHECKS = 1`))
      }),
    )
  }),
}

export const resetSchema = (options: BetterAuthOptions): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dialect = yield* dialectOf
    const statements = yield* schemaStatements(getAuthTables(options), {
      dialect,
      idStrategy: idStrategyOf(options),
      rename: clientNames(sql, dialect),
    })
    yield* dropAllTables[dialect]
    yield* Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true })
  })

const container = <C extends { readonly stop: () => Promise<unknown> }>(start: () => Promise<C>) =>
  Effect.acquireRelease(Effect.promise(start), (started) => Effect.promise(() => started.stop()))

export interface SqliteOptions {
  /** Through the client's name transforms, not better-auth's `fields`. */
  readonly snakeCase?: boolean
}

const snakeCaseNames = (snakeCase: boolean) =>
  snakeCase ? { transformQueryNames: Str.camelToSnake, transformResultNames: Str.snakeToCamel } : {}

export const sqliteDatabase = ({ snakeCase = false }: SqliteOptions = {}): Database =>
  SqliteClient.layer({ filename: ':memory:', ...snakeCaseNames(snakeCase) })

export interface DatabaseOptions {
  readonly maxConnections?: number
  /**
   * Off for tests that recreate tables with other column types on one pool: cached statements
   * outlive the table (PostgreSQL errors, MySQL 8.4 silently reads nothing).
   */
  readonly preparedStatements?: boolean
}

export const postgresDatabase = ({ maxConnections, preparedStatements = true }: DatabaseOptions = {}): Database =>
  Layer.unwrap(
    Effect.map(
      container(() => new PostgreSqlContainer('postgres:17-alpine').start()),
      (started) =>
        PgClient.layer({
          url: Redacted.make(started.getConnectionUri()),
          prepare: preparedStatements,
          maxConnections,
        }),
    ),
  )

/** mysql2 uses local time for `Date` by default; `MysqlClient` ignores `poolConfig` next to a `url`. */
const utcMysqlUrl = (uri: string): string => `${uri}${new URL(uri).search === '' ? '?' : '&'}timezone=Z`

export const mysqlDatabase = ({ maxConnections, preparedStatements = true }: DatabaseOptions = {}): Database =>
  Layer.unwrap(
    Effect.map(
      container(() => new MySqlContainer('mysql:8.4').start()),
      (started) =>
        MysqlClient.layer({
          url: Redacted.make(utcMysqlUrl(started.getConnectionUri())),
          disablePreparedStatements: !preparedStatements,
          maxConnections,
        }),
    ),
  )
