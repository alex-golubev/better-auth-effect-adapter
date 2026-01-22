import { Effect } from "effect"
import { SqlClient } from "@effect/sql"
import type { Fragment, Primitive } from "@effect/sql/Statement"
import { createAdapterFactory, type Where } from "better-auth/adapters"
import type { WhereCondition } from "./where-builder.js"
import { buildWhereClause } from "./where-builder.js"
import { getReturningStrategy } from "./returning.js"
import { runAdapterEffect } from "./errors.js"
import type { EffectSqlAdapterConfig, SqlData } from "./types.js"

/**
 * Retrieves the number of affected rows from the input object, based on known keys.
 *
 * This function checks the input object for the presence of specific properties that
 * commonly represent the count of affected rows in database operations (`affectedRows`,
 * `rowCount`, or `changes`). If any of these properties are found and are of type `number`,
 * their value is returned. If none of these properties are present or the input is not
 * an object, the function returns 0.
 *
 * @param {unknown} raw - The input value, expected to be an object containing one of the
 *                        known properties (`affectedRows`, `rowCount`, or `changes`) representing
 *                        the number of affected rows.
 * @returns {number} The number of affected rows if a valid property is found, otherwise 0.
 */
const getAffectedRows = (raw: unknown): number => {
  if (typeof raw !== "object" || raw === null) return 0
  const result = raw as Record<string, unknown>
  if (typeof result.affectedRows === "number") return result.affectedRows
  if (typeof result.rowCount === "number") return result.rowCount
  if (typeof result.changes === "number") return result.changes
  return 0
}

/**
 * Determines if a given value is either a plain object or an array.
 *
 * A plain object is considered an object directly created by the `Object` constructor
 * or one with a prototype of `Object.prototype`. Arrays are also explicitly checked.
 *
 * @param value - The value to evaluate.
 * @returns A boolean indicating whether the value is a plain object or an array.
 */
const isPlainObjectOrArray = (value: unknown): value is Record<string, unknown> | unknown[] =>
  value !== null &&
  typeof value === "object" &&
  (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)

/**
 * Safely serializes a value to JSON, handling circular references.
 *
 * Uses a WeakSet to track visited objects. If a circular reference is detected,
 * the circular property is omitted from the output (replaced with `undefined`).
 *
 * @param {Record<string, unknown> | unknown[]} value - The plain object or array to serialize.
 * @returns {string} The JSON string representation of the value.
 */
const safeJsonStringify = (value: Record<string, unknown> | unknown[]): string => {
  const seen = new WeakSet()
  return JSON.stringify(value, (_, v) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return undefined
      seen.add(v)
    }
    return v
  })
}

/**
 * Converts a given data object into a format compatible with SQL data requirements.
 * The function processes the input object and ensures that its properties are converted
 * into primitive types, JSON strings, or string representations as needed.
 *
 * @param {Record<string, unknown>} data - The input object containing key-value pairs to be converted.
 * @returns {SqlData} A new object where each property is formatted to meet SQL data compatibility.
 */
const toSqlData = (data: Record<string, unknown>): SqlData => {
  const result: SqlData = {}
  for (const [key, value] of Object.entries(data)) {
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean" ||
      value instanceof Date ||
      value instanceof Int8Array ||
      value instanceof Uint8Array
    ) {
      result[key] = value as Primitive | undefined
    } else if (isPlainObjectOrArray(value)) {
      result[key] = safeJsonStringify(value)
    } else {
      result[key] = String(value)
    }
  }
  return result
}

/**
 * Converts an array of `Where` conditions into a formatted array of `WhereCondition` objects.
 *
 * @param {Required<Where>[]} where - An array of required `Where` objects, where each object contains the conditions to be transformed.
 * @param {function} getFieldName - A function that converts a field definition into its formatted field name. Accepts an object
 * with properties `model` and `field` as arguments and returns the corresponding field name as a string.
 * @param {string} model - The name of the model to be used in the `getFieldName` function.
 * @returns {WhereCondition[]} An array of `WhereCondition` objects, with each condition containing the formatted field name, value,
 * operator, and connector. Default values are applied where necessary: `operator` defaults to `"eq"`, and `connector` defaults to `"AND"`.
 */
const toWhereConditions = (
  where: Required<Where>[],
  getFieldName: (opts: { model: string; field: string }) => string,
  model: string,
): WhereCondition[] =>
  where.map((w) => ({
    field: getFieldName({ model, field: w.field }),
    value: w.value,
    operator: w.operator ?? "eq",
    connector: w.connector ?? "AND",
  }))

/**
 * Creates an SQL adapter with effect-based operations for interacting with a database.
 *
 * @param {EffectSqlAdapterConfig} adapterConfig - Configuration for the SQL adapter, including runtime and dialect settings.
 *
 * The adapter provides methods to:
 * - Insert a record into the database with the `create` method.
 * - Retrieve a single record matching specific conditions using the `findOne` method.
 * - Fetch multiple records, optionally filtered by conditions, with the `findMany` method.
 * - Update a single record using the `update` method.
 * - Perform multiple updates using the `updateMany` method.
 * - Delete a single record with the `delete` method.
 * - Delete multiple records using `deleteMany`.
 * - Count records matching specific conditions using the `count` method.
 */
export const effectSqlAdapter = (adapterConfig: EffectSqlAdapterConfig) => {
  const { runtime, dialect } = adapterConfig
  const returningStrategy = getReturningStrategy(dialect)

  const createCustomAdapter = () => ({
    getFieldName,
  }: {
    getFieldName: (opts: { model: string; field: string }) => string
    options: unknown
  }) => {
    const withSql = <A>(
      fn: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, never>,
    ): Effect.Effect<A, unknown, SqlClient.SqlClient> =>
      Effect.flatMap(SqlClient.SqlClient, fn)

    const buildSelectColumns = (
      sql: SqlClient.SqlClient,
      select: string[] | undefined,
    ): Fragment => {
      if (!select?.length) return sql.literal("*")
      const columns = select.map((col) => sql`${sql(col)}`)
      return sql.join(", ", false, "*")(columns)
    }

    const buildOrderBy = (
      sql: SqlClient.SqlClient,
      sortBy: { field: string; direction: "asc" | "desc" } | undefined,
      getFieldName: (opts: { model: string; field: string }) => string,
      model: string,
    ): Fragment => {
      if (!sortBy) return sql.literal("")
      const field = sql(getFieldName({ model, field: sortBy.field }))
      const direction = sortBy.direction === "desc" ? sql.literal("DESC") : sql.literal("ASC")
      return sql`ORDER BY ${field} ${direction}`
    }

    const buildLimitOffset = (
      sql: SqlClient.SqlClient,
      limit: number,
      offset?: number,
    ): Fragment =>
      offset
        ? sql`LIMIT ${limit} OFFSET ${offset}`
        : sql`LIMIT ${limit}`

    return {
      create: async <T extends Record<string, unknown>>({
        model,
        data,
      }: {
        model: string
        data: T
        select?: string[]
      }): Promise<T> => {
        const sqlData = toSqlData(data)

        return runAdapterEffect(
          withSql((sql) =>
            returningStrategy.insertReturning<T>(sql, model, sqlData),
          ),
          runtime,
        )
      },

      findOne: async <T>({
        model,
        where,
        select,
      }: {
        model: string
        where: Required<Where>[]
        select?: string[]
      }): Promise<T | null> => {
        const conditions = toWhereConditions(where, getFieldName, model)

        return runAdapterEffect(
          withSql((sql) =>
            Effect.gen(function* () {
              const columns = buildSelectColumns(sql, select)
              const whereClause = buildWhereClause(sql, conditions)

              const query = whereClause
                ? sql<Record<string, unknown>>`
                    SELECT ${columns} FROM ${sql(model)}
                    WHERE ${whereClause}
                    LIMIT 1
                  `
                : sql<Record<string, unknown>>`
                    SELECT ${columns} FROM ${sql(model)}
                    LIMIT 1
                  `

              const result = yield* query
              return (result[0] as T | undefined) ?? null
            }),
          ),
          runtime,
        )
      },

      findMany: async <T>({
        model,
        where,
        limit,
        sortBy,
        offset,
      }: {
        model: string
        where?: Required<Where>[]
        limit: number
        sortBy?: { field: string; direction: "asc" | "desc" }
        offset?: number
      }): Promise<T[]> => {
        const conditions = where
          ? toWhereConditions(where, getFieldName, model)
          : []

        return runAdapterEffect(
          withSql((sql) =>
            Effect.gen(function* () {
              const whereClause = buildWhereClause(sql, conditions)
              const orderBy = buildOrderBy(sql, sortBy, getFieldName, model)
              const limitOffset = buildLimitOffset(sql, limit, offset)

              const query = whereClause
                ? sql<Record<string, unknown>>`
                    SELECT * FROM ${sql(model)}
                    WHERE ${whereClause}
                    ${orderBy}
                    ${limitOffset}
                  `
                : sql<Record<string, unknown>>`
                    SELECT * FROM ${sql(model)}
                    ${orderBy}
                    ${limitOffset}
                  `

              const results = yield* query
              return results as T[]
            }),
          ),
          runtime,
        )
      },

      update: async <T>({
        model,
        where,
        update: updateData,
      }: {
        model: string
        where: Required<Where>[]
        update: T
      }): Promise<T | null> => {
        const conditions = toWhereConditions(where, getFieldName, model)
        const sqlData = toSqlData(updateData as Record<string, unknown>)

        return runAdapterEffect(
          withSql((sql) =>
            Effect.gen(function* () {
              const whereClause = buildWhereClause(sql, conditions)

              if (!whereClause) {
                return yield* Effect.die(
                  new Error("UPDATE requires WHERE clause"),
                )
              }

              const result =
                yield* returningStrategy.updateReturning<Record<string, unknown>>(
                  sql,
                  model,
                  whereClause,
                  sqlData,
                )

              return result as T | null
            }),
          ),
          runtime,
        )
      },

      updateMany: async ({
        model,
        where,
        update: updateData,
      }: {
        model: string
        where: Required<Where>[]
        update: Record<string, unknown>
      }): Promise<number> => {
        const conditions = toWhereConditions(where, getFieldName, model)
        const sqlData = toSqlData(updateData)

        return runAdapterEffect(
          withSql((sql) =>
            Effect.gen(function* () {
              const whereClause = buildWhereClause(sql, conditions)

              if (!whereClause) {
                return yield* Effect.die(
                  new Error("UPDATE requires WHERE clause"),
                )
              }

              const raw = yield* sql`
                UPDATE ${sql(model)}
                SET ${sql.update(sqlData)}
                WHERE ${whereClause}
              `.raw

              return getAffectedRows(raw)
            }),
          ),
          runtime,
        )
      },

      delete: async ({
        model,
        where,
      }: {
        model: string
        where: Required<Where>[]
      }): Promise<void> => {
        const conditions = toWhereConditions(where, getFieldName, model)

        return runAdapterEffect(
          withSql((sql) =>
            Effect.gen(function* () {
              const whereClause = buildWhereClause(sql, conditions)

              if (!whereClause) {
                return yield* Effect.die(
                  new Error("DELETE requires WHERE clause"),
                )
              }

              yield* sql`
                DELETE FROM ${sql(model)}
                WHERE ${whereClause}
              `
            }),
          ),
          runtime,
        )
      },

      deleteMany: async ({
        model,
        where,
      }: {
        model: string
        where: Required<Where>[]
      }): Promise<number> => {
        const conditions = toWhereConditions(where, getFieldName, model)

        return runAdapterEffect(
          withSql((sql) =>
            Effect.gen(function* () {
              const whereClause = buildWhereClause(sql, conditions)

              if (!whereClause) {
                return yield* Effect.die(
                  new Error("DELETE requires WHERE clause"),
                )
              }

              const raw = yield* sql`
                DELETE FROM ${sql(model)}
                WHERE ${whereClause}
              `.raw

              return getAffectedRows(raw)
            }),
          ),
          runtime,
        )
      },

      count: async ({
        model,
        where,
      }: {
        model: string
        where?: Required<Where>[]
      }): Promise<number> => {
        const conditions = where
          ? toWhereConditions(where, getFieldName, model)
          : []

        return runAdapterEffect(
          withSql((sql) =>
            Effect.gen(function* () {
              const whereClause = buildWhereClause(sql, conditions)

              const query = whereClause
                ? sql<{ count: string | number }>`
                    SELECT COUNT(*) as count
                    FROM ${sql(model)}
                    WHERE ${whereClause}
                  `
                : sql<{ count: string | number }>`
                    SELECT COUNT(*) as count
                    FROM ${sql(model)}
                  `

              const result = yield* query
              const row = result[0]

              return Number(row?.count ?? 0)
            }),
          ),
          runtime,
        )
      },

      options: adapterConfig,
    }
  }

  return createAdapterFactory({
    config: {
      adapterId: "effect-sql",
      adapterName: "Effect SQL Adapter",
      supportsJSON: true,
      supportsDates: true,
      supportsBooleans: true,
      debugLogs: adapterConfig.debugLogs ?? false,
    },
    adapter: createCustomAdapter(),
  })
}
