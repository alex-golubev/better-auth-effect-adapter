import { Effect } from "effect"
import { SqlClient } from "@effect/sql"
import type { Fragment, Primitive } from "@effect/sql/Statement"
import { createAdapterFactory, type Where } from "better-auth/adapters"
import type { WhereCondition } from "./where-builder.js"
import { buildWhereClause } from "./where-builder.js"
import { getReturningStrategy } from "./returning.js"
import { runAdapterEffect } from "./errors.js"
import type { EffectSqlAdapterConfig } from "./types.js"

type SqlData = Record<string, Primitive | Fragment | undefined>

// Extract affected rows from raw driver result
// MySQL: { affectedRows: number }, PostgreSQL: { rowCount: number }, SQLite: { changes: number }
const getAffectedRows = (raw: unknown): number => {
  if (typeof raw !== "object" || raw === null) return 0
  const result = raw as Record<string, unknown>
  if (typeof result.affectedRows === "number") return result.affectedRows
  if (typeof result.rowCount === "number") return result.rowCount
  if (typeof result.changes === "number") return result.changes
  return 0
}

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
    } else {
      result[key] = JSON.stringify(value)
    }
  }
  return result
}

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
      return sql.csv(select)
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
