import { Effect } from "effect"
import type { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import type { Fragment, Primitive } from "@effect/sql/Statement"
import type { Dialect } from "./types.js"

type SqlData = Record<string, Primitive | Fragment | undefined>

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
        return yield* Effect.die(new Error(`Failed to insert into ${tableName}`))
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

const sqliteStrategy: ReturningStrategy = pgStrategy

const mysqlStrategy: ReturningStrategy = {
  insertReturning: <T extends Record<string, unknown>>(
    sql: SqlClient.SqlClient,
    tableName: string,
    data: SqlData,
  ) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO ${sql(tableName)} ${sql.insert(data)}`

      const idValue = data["id"]
      if (idValue !== undefined) {
        const result = yield* sql<T>`
          SELECT * FROM ${sql(tableName)} WHERE ${sql("id")} = ${idValue}
        `
        const row = result[0]
        if (!row) {
          return yield* Effect.die(new Error(`Failed to fetch inserted row from ${tableName}`))
        }
        return row
      }

      const result = yield* sql<T>`
        SELECT * FROM ${sql(tableName)} WHERE id = LAST_INSERT_ID()
      `
      const row = result[0]
      if (!row) {
        return yield* Effect.die(new Error(`Failed to fetch inserted row from ${tableName}`))
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
      yield* sql`
        UPDATE ${sql(tableName)}
        SET ${sql.update(data)}
        WHERE ${whereClause}
      `

      const result = yield* sql<T>`
        SELECT * FROM ${sql(tableName)}
        WHERE ${whereClause}
        LIMIT 1
      `
      return result[0] ?? null
    }),
}

export const getReturningStrategy = (dialect: Dialect): ReturningStrategy => {
  switch (dialect) {
    case "pg":
      return pgStrategy
    case "sqlite":
      return sqliteStrategy
    case "mysql":
      return mysqlStrategy
    default: {
      const _exhaustive: never = dialect
      throw new Error(`Unknown dialect: ${_exhaustive}`)
    }
  }
}
