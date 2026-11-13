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
import { type Dialect, detectDialect } from '../src/dialect'
import { EffectSqlAdapterError } from '../src/errors'
import { clientNames, idStrategyOf, schemaStatements } from '../src/schema'

/** A database the integration tests run against: its SqlClient, released with the layer. */
export type Database = Layer.Layer<SqlClient.SqlClient, unknown>

/**
 * Shares `database` between the tests of a block (`@effect/vitest`'s `layer`). The tests
 * keep the live clock: their timeouts must really fire, and the drivers keep real time.
 */
export const withDatabase = <R, E>(database: Layer.Layer<R, E>) => layer(database, { excludeTestServices: true })

/** The dialect of the SqlClient in context. */
export const dialectOf: Effect.Effect<Dialect, EffectSqlAdapterError, SqlClient.SqlClient> = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.mapError(
      Effect.fromOption(detectDialect(sql)),
      () => new EffectSqlAdapterError({ message: `Unsupported driver "${sql.driver}"` }),
    ),
)

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

/**
 * Drops every table, then creates the schema for `options` with our DDL generator,
 * naming tables and columns as the client does (`transformQueryNames`).
 */
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

/** A started testcontainers container, stopped when the scope (the layer using it) closes. */
const container = <C extends { readonly stop: () => Promise<unknown> }>(start: () => Promise<C>) =>
  Effect.acquireRelease(Effect.promise(start), (started) => Effect.promise(() => started.stop()))

export interface SqliteOptions {
  /** snake_case columns through the client's `transformQueryNames` / `transformResultNames`. */
  readonly snakeCase?: boolean
}

const snakeCaseNames = (snakeCase: boolean) =>
  snakeCase ? { transformQueryNames: Str.camelToSnake, transformResultNames: Str.snakeToCamel } : {}

export const sqliteDatabase = ({ snakeCase = false }: SqliteOptions = {}): Database =>
  SqliteClient.layer({ filename: ':memory:', ...snakeCaseNames(snakeCase) })

export interface DatabaseOptions {
  readonly maxConnections?: number
  /**
   * Server-side prepared statements, on by default as in both drivers. Turn them off for
   * tests that recreate tables with different column types (text/integer/uuid ids) on one
   * pool: the drivers cache statements per connection by SQL text, and a cached statement
   * outlives the table it was prepared for. PostgreSQL then fails with "operator does not
   * exist: uuid = text"; MySQL 8.4 uses stale column types, so inserts fail ("Data too long")
   * and reads compare as numbers and silently match nothing, on whichever pooled connection
   * still holds the old statement.
   */
  readonly preparedStatements?: boolean
}

const maxConnectionsOption = (maxConnections: number | undefined) =>
  maxConnections === undefined ? {} : { maxConnections }

export const postgresDatabase = ({ maxConnections, preparedStatements = true }: DatabaseOptions = {}): Database =>
  Layer.unwrap(
    Effect.map(
      container(() => new PostgreSqlContainer('postgres:17-alpine').start()),
      (started) =>
        PgClient.layer({
          url: Redacted.make(started.getConnectionUri()),
          prepare: preparedStatements,
          ...maxConnectionsOption(maxConnections),
        }),
    ),
  )

/**
 * mysql2 reads and writes `Date` values in the process's local time zone unless told
 * otherwise, so timestamps shift whenever TZ differs between writes and reads. `MysqlClient`
 * ignores `poolConfig` when given a `url`, so the option goes into the URL.
 */
const utcMysqlUrl = (uri: string): string => `${uri}${new URL(uri).search === '' ? '?' : '&'}timezone=Z`

export const mysqlDatabase = ({ maxConnections, preparedStatements = true }: DatabaseOptions = {}): Database =>
  Layer.unwrap(
    Effect.map(
      container(() => new MySqlContainer('mysql:8.4').start()),
      (started) =>
        MysqlClient.layer({
          url: Redacted.make(utcMysqlUrl(started.getConnectionUri())),
          disablePreparedStatements: !preparedStatements,
          ...maxConnectionsOption(maxConnections),
        }),
    ),
  )
