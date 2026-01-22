import { Effect, Option, pipe } from 'effect'
import type { SqlClient } from '@effect/sql'
import type { SqlError } from '@effect/sql/SqlError'
import type { Fragment } from '@effect/sql/Statement'
import type { Dialect, Primitive, SqlData } from './types.js'
import { AdapterError } from './errors.js'

export interface ReturningStrategy {
  readonly insertReturning: <T extends Record<string, unknown>>(
    sql: SqlClient.SqlClient,
    tableName: string,
    data: SqlData,
  ) => Effect.Effect<T, SqlError>

  readonly updateReturning: <T extends Record<string, unknown>>(
    sql: SqlClient.SqlClient,
    tableName: string,
    whereClause: Fragment,
    data: SqlData,
  ) => Effect.Effect<T | null, SqlError>
}

/**
 * Requires a row to exist or dies with an AdapterError.
 * Eliminates repetitive null checks throughout the strategies.
 */
const requireRow = <T>(row: T | undefined, errorMessage: string): Effect.Effect<T, never, never> =>
  pipe(
    row,
    Option.fromNullable,
    Option.match({
      onNone: () => Effect.die(new AdapterError({ message: errorMessage })),
      onSome: Effect.succeed,
    }),
  )

/**
 * PostgreSQL returning strategy using native RETURNING clause.
 */
const pgStrategy: ReturningStrategy = {
  insertReturning: <T extends Record<string, unknown>>(sql: SqlClient.SqlClient, tableName: string, data: SqlData) =>
    Effect.gen(function* () {
      const result = yield* sql<T>`
        INSERT INTO ${sql(tableName)} ${sql.insert(data)}
        RETURNING *
      `
      return yield* requireRow(result[0], `INSERT into "${tableName}" returned no rows`)
    }),

  updateReturning: <T extends Record<string, unknown>>(
    sql: SqlClient.SqlClient,
    tableName: string,
    whereClause: Fragment,
    data: SqlData,
  ) =>
    Effect.gen(function* () {
      const result = yield* sql<T>`
        UPDATE ${sql(tableName)}
        SET ${sql.update(data)}
        WHERE ${whereClause}
        RETURNING *
      `
      return result[0] ?? null
    }),
}

/**
 * SQLite returning strategy (same as PostgreSQL, uses native RETURNING).
 */
const sqliteStrategy: ReturningStrategy = pgStrategy

/**
 * Fetches a row by id and requires it to exist.
 * Used by MySQL strategy which doesn't support RETURNING.
 */
const fetchRowById = <T extends Record<string, unknown>>(
  sql: SqlClient.SqlClient,
  tableName: string,
  id: Primitive,
  errorContext: string,
): Effect.Effect<T, SqlError, never> =>
  Effect.gen(function* () {
    const result = yield* sql<T>`
      SELECT * FROM ${sql(tableName)} WHERE ${sql('id')} = ${id}
    `
    return yield* requireRow(result[0], `INSERT into "${tableName}" returned no rows (${errorContext})`)
  })

/**
 * MySQL returning strategy using LAST_INSERT_ID() fallback.
 * Requires tables to have an `id` column as primary key.
 */
const mysqlStrategy: ReturningStrategy = {
  insertReturning: <T extends Record<string, unknown>>(sql: SqlClient.SqlClient, tableName: string, data: SqlData) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO ${sql(tableName)} ${sql.insert(data)}`

        const idValue = data['id'] as Primitive | undefined

        return yield* pipe(
          idValue,
          Option.fromNullable,
          Option.match({
            onNone: () =>
              Effect.gen(function* () {
                const result = yield* sql<T>`
                  SELECT * FROM ${sql(tableName)} WHERE id = LAST_INSERT_ID()
                `
                return yield* requireRow(result[0], `INSERT into "${tableName}" returned no rows (LAST_INSERT_ID)`)
              }),
            onSome: (id) => fetchRowById<T>(sql, tableName, id, `id: ${String(id)}`),
          }),
        )
      }),
    ),

  updateReturning: <T extends Record<string, unknown>>(
    sql: SqlClient.SqlClient,
    tableName: string,
    whereClause: Fragment,
    data: SqlData,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<{ id: Primitive }>`
          SELECT id FROM ${sql(tableName)}
          WHERE ${whereClause}
          LIMIT 1
          FOR UPDATE
        `

        return yield* pipe(
          existing[0],
          Option.fromNullable,
          Option.match({
            onNone: () => Effect.succeed(null as T | null),
            onSome: ({ id }) =>
              Effect.gen(function* () {
                yield* sql`
                  UPDATE ${sql(tableName)}
                  SET ${sql.update(data)}
                  WHERE ${sql('id')} = ${id}
                `
                const result = yield* sql<T>`
                  SELECT * FROM ${sql(tableName)}
                  WHERE ${sql('id')} = ${id}
                `
                return result[0] ?? null
              }),
          }),
        )
      }),
    ),
}

/**
 * Strategy lookup by dialect.
 */
const strategies: Record<Dialect, ReturningStrategy> = {
  pg: pgStrategy,
  sqlite: sqliteStrategy,
  mysql: mysqlStrategy,
}

/**
 * Returns the appropriate returning strategy for the given SQL dialect.
 */
export const getReturningStrategy = (dialect: Dialect): ReturningStrategy => strategies[dialect]
