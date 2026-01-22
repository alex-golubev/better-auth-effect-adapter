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
      }: {
        model: string
        where: Required<Where>[]
        select?: string[]
      }): Promise<T | null> => {
        const conditions = toWhereConditions(where, getFieldName, model)

        return runAdapterEffect(
          withSql((sql) =>
            Effect.gen(function* () {
              const whereClause = buildWhereClause(sql, conditions)

              const query = whereClause
                ? sql<Record<string, unknown>>`
                    SELECT * FROM ${sql(model)}
                    WHERE ${whereClause}
                    LIMIT 1
                  `
                : sql<Record<string, unknown>>`
                    SELECT * FROM ${sql(model)}
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

              const sortField = sortBy
                ? getFieldName({ model, field: sortBy.field })
                : null
              const orderBy = sortField
                ? sql.literal(
                    `ORDER BY "${sortField}" ${sortBy!.direction.toUpperCase()}`,
                  )
                : sql.literal("")

              const limitClause = sql.literal(`LIMIT ${limit}`)
              const offsetClause = offset
                ? sql.literal(`OFFSET ${offset}`)
                : sql.literal("")

              const query = whereClause
                ? sql<Record<string, unknown>>`
                    SELECT * FROM ${sql(model)}
                    WHERE ${whereClause}
                    ${orderBy}
                    ${limitClause}
                    ${offsetClause}
                  `
                : sql<Record<string, unknown>>`
                    SELECT * FROM ${sql(model)}
                    ${orderBy}
                    ${limitClause}
                    ${offsetClause}
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

              const query = whereClause
                ? sql`
                    UPDATE ${sql(model)}
                    SET ${sql.update(sqlData)}
                    WHERE ${whereClause}
                  `
                : sql`
                    UPDATE ${sql(model)}
                    SET ${sql.update(sqlData)}
                  `

              yield* query
              return 0
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

              const query = whereClause
                ? sql`DELETE FROM ${sql(model)} WHERE ${whereClause}`
                : sql`DELETE FROM ${sql(model)}`

              yield* query
              return 0
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
