import { Effect } from "effect"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import type { Fragment, Primitive } from "@effect/sql/Statement"
import type { Dialect, SqlData } from "./types.js"
import { AdapterError } from "./errors.js"

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
 * `pgStrategy` is a PostgreSQL-specific implementation of a returning strategy,
 * designed to handle database interactions that involve operations requiring the
 * `RETURNING` clause. It provides methods to execute `INSERT` and `UPDATE`
 * statements, returning affected rows as part of the result.
 *
 * This variable is intended to be used in conjunction with a PostgreSQL client
 * and enables more convenient and reliable handling of `RETURNING` queries.
 *
 * Properties:
 * - `insertReturning`: A function to perform an `INSERT` operation into a
 *   specified table, returning the inserted row.
 * - `updateReturning`: A function to perform an `UPDATE` operation on a
 *   specified table with a condition, returning the updated row or `null` if
 *   no rows were updated.
 *
 * Usage Notes:
 * - Both methods use parameterized SQL queries to ensure safety against SQL injection.
 * - The queries rely on the `RETURNING *` clause, which requires that the
 *   database supports this syntax.
 */
const pgStrategy: ReturningStrategy = {
  insertReturning: <T extends Record<string, unknown>>(
    sql: SqlClient.SqlClient,
    tableName: string,
    data: SqlData,
  ) =>
    Effect.gen(function* () {
      const result = yield* sql<T>`
        INSERT INTO ${sql(tableName)} ${sql.insert(data)}
        RETURNING *
      `
      const row = result[0]
      if (!row) {
        return yield* Effect.die(
          new AdapterError({
            message: `INSERT into "${tableName}" returned no rows`,
          }),
        )
      }
      return row
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
 * Represents the SQLite returning strategy for database queries.
 * This strategy determines how the returning fields are handled
 * after executing an operation like INSERT or UPDATE in an SQLite
 * database. It is aligned to behave similarly to the PostgreSQL
 * returning strategy for consistency.
 *
 * @type {ReturningStrategy}
 */
const sqliteStrategy: ReturningStrategy = pgStrategy

/**
 * Provides strategies for insert and update operations in a MySQL database,
 * ensuring the ability to return the affected rows.
 *
 * **Important:** MySQL does not support the `RETURNING` clause. This strategy
 * requires tables to have an `id` column as the primary key. It uses either
 * the provided `id` value or `LAST_INSERT_ID()` to fetch the inserted/updated row.
 *
 * @type {ReturningStrategy}
 *
 * @property {function} insertReturning - A function to perform an `INSERT` operation into a MySQL table
 *   and return the inserted row. Uses a transaction to ensure consistency and supports returning rows based
 *   on either the provided `id` field in the data or the `LAST_INSERT_ID`.
 *
 * @property {function} updateReturning - A function to perform an `UPDATE` operation on a MySQL table
 *   and return the updated row. Locks the row beforehand to avoid race conditions and ensures the operation
 *   only proceeds if the row exists.
 */
const mysqlStrategy: ReturningStrategy = {
  insertReturning: <T extends Record<string, unknown>>(
    sql: SqlClient.SqlClient,
    tableName: string,
    data: SqlData,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO ${sql(tableName)} ${sql.insert(data)}`

        const idValue = data["id"]
        if (idValue !== undefined) {
          const result = yield* sql<T>`
            SELECT * FROM ${sql(tableName)} WHERE ${sql("id")} = ${idValue}
          `
          const row = result[0]
          if (!row) {
            return yield* Effect.die(
              new AdapterError({
                message: `INSERT into "${tableName}" returned no rows (id: ${String(idValue)})`,
              }),
            )
          }
          return row
        }

        const result = yield* sql<T>`
          SELECT * FROM ${sql(tableName)} WHERE id = LAST_INSERT_ID()
        `
        const row = result[0]
        if (!row) {
          return yield* Effect.die(
            new AdapterError({
              message: `INSERT into "${tableName}" returned no rows (LAST_INSERT_ID)`,
            }),
          )
        }
        return row
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
        // Lock the row first to prevent race conditions
        const existing = yield* sql<{ id: Primitive }>`
          SELECT id FROM ${sql(tableName)}
          WHERE ${whereClause}
          LIMIT 1
          FOR UPDATE
        `
        if (!existing[0]) return null

        const id = existing[0].id

        yield* sql`
          UPDATE ${sql(tableName)}
          SET ${sql.update(data)}
          WHERE ${sql("id")} = ${id}
        `

        const result = yield* sql<T>`
          SELECT * FROM ${sql(tableName)}
          WHERE ${sql("id")} = ${id}
        `
        return result[0] ?? null
      }),
    ),
}

/**
 * Determines the returning strategy based on the provided SQL dialect.
 *
 * @param {Dialect} dialect - The SQL dialect for which the returning strategy is needed.
 * @returns {ReturningStrategy} The corresponding strategy for the given dialect.
 */
export const getReturningStrategy = (dialect: Dialect): ReturningStrategy => {
  switch (dialect) {
    case "pg":
      return pgStrategy
    case "sqlite":
      return sqliteStrategy
    case "mysql":
      return mysqlStrategy
    default: {
      throw new Error(`Unknown dialect: ${dialect}`)
    }
  }
}
