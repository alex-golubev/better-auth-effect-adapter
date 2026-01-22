import { Effect, Option, pipe } from 'effect'
import { SqlClient } from '@effect/sql'
import type { Fragment } from '@effect/sql/Statement'
import type { Primitive } from './types.js'
import { createAdapterFactory, type Where } from 'better-auth/adapters'
import type { WhereCondition } from './where-builder.js'
import { buildWhereClause } from './where-builder.js'
import { getReturningStrategy } from './returning.js'
import { runAdapterEffect } from './errors.js'
import type { EffectSqlAdapterConfig, SqlData } from './types.js'

/**
 * Retrieves the number of affected rows from the input object, based on known keys.
 * Uses Option monad for safe property access.
 */
const getAffectedRows = (raw: unknown): number =>
  pipe(
    raw,
    Option.liftPredicate((v): v is Record<string, unknown> => typeof v === 'object' && v !== null),
    Option.flatMap((r) => Option.fromNullable(r.affectedRows ?? r.rowCount ?? r.changes)),
    Option.filter((v): v is number => typeof v === 'number'),
    Option.getOrElse(() => 0),
  )

/**
 * Determines if a given value is either a plain object or an array.
 */
const isPlainObjectOrArray = (value: unknown): value is Record<string, unknown> | unknown[] =>
  value !== null &&
  typeof value === 'object' &&
  (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)

/**
 * Checks if a value is a SQL primitive type.
 */
const isPrimitive = (value: unknown): value is Primitive | undefined =>
  value === null ||
  value === undefined ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'boolean' ||
  value instanceof Date ||
  value instanceof Int8Array ||
  value instanceof Uint8Array

/**
 * Safely serializes a value to JSON, handling circular references.
 */
const safeJsonStringify = (value: Record<string, unknown> | unknown[]): string => {
  const seen = new WeakSet()
  return JSON.stringify(value, (_, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return undefined
      seen.add(v)
    }
    return v
  })
}

/**
 * Converts a single value to SQL-compatible format.
 */
const convertToSqlValue = (value: unknown): Primitive | undefined =>
  isPrimitive(value) ? value : isPlainObjectOrArray(value) ? safeJsonStringify(value) : String(value)

/**
 * Converts a given data object into a format compatible with SQL data requirements.
 * Pure function using Object.fromEntries for immutable transformation.
 */
const toSqlData = (data: Record<string, unknown>): SqlData =>
  Object.fromEntries(Object.entries(data).map(([key, value]) => [key, convertToSqlValue(value)]))

/**
 * Converts an array of `Where` conditions into a formatted array of `WhereCondition` objects.
 */
const toWhereConditions = (
  where: Required<Where>[],
  getFieldName: (opts: { model: string; field: string }) => string,
  model: string,
): WhereCondition[] =>
  where.map((w) => ({
    field: getFieldName({ model, field: w.field }),
    value: w.value,
    operator: w.operator ?? 'eq',
    connector: w.connector ?? 'AND',
  }))

/**
 * Requires a WHERE clause or dies with an error.
 * Extracts common validation logic for UPDATE/DELETE operations.
 */
const requireWhereClause = (clause: Fragment | null, operation: string): Effect.Effect<Fragment, never, never> =>
  clause ? Effect.succeed(clause) : Effect.die(new Error(`${operation} requires WHERE clause`))

/**
 * Builds SELECT columns fragment.
 */
const buildSelectColumns = (sql: SqlClient.SqlClient, select: string[] | undefined): Fragment => {
  if (!select?.length) return sql.literal('*')
  const columns = select.map((col) => sql`${sql(col)}`)
  return sql.join(', ', false, '*')(columns)
}

/**
 * Builds ORDER BY fragment.
 */
const buildOrderBy = (
  sql: SqlClient.SqlClient,
  sortBy: { field: string; direction: 'asc' | 'desc' } | undefined,
  getFieldName: (opts: { model: string; field: string }) => string,
  model: string,
): Fragment => {
  if (!sortBy) return sql.literal('')
  const field = sql(getFieldName({ model, field: sortBy.field }))
  const direction = sortBy.direction === 'desc' ? sql.literal('DESC') : sql.literal('ASC')
  return sql`ORDER BY ${field} ${direction}`
}

/**
 * Builds LIMIT/OFFSET fragment.
 */
const buildLimitOffset = (sql: SqlClient.SqlClient, limit: number, offset?: number): Fragment =>
  offset ? sql`LIMIT ${limit} OFFSET ${offset}` : sql`LIMIT ${limit}`

/**
 * Creates an SQL adapter with effect-based operations for interacting with a database.
 *
 * @template R - The environment type provided by the runtime (must include SqlClient.SqlClient)
 * @template E - The error type of the runtime
 * @param {EffectSqlAdapterConfig<R, E>} adapterConfig - Configuration for the SQL adapter, including runtime and dialect settings.
 */
export const effectSqlAdapter = <R extends SqlClient.SqlClient = SqlClient.SqlClient, E = unknown>(
  adapterConfig: EffectSqlAdapterConfig<R, E>,
) => {
  const { runtime, dialect } = adapterConfig
  const returningStrategy = getReturningStrategy(dialect)

  const createCustomAdapter =
    () =>
    ({ getFieldName }: { getFieldName: (opts: { model: string; field: string }) => string; options: unknown }) => {
      const withSql = <A>(
        fn: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, never>,
      ): Effect.Effect<A, unknown, SqlClient.SqlClient> => Effect.flatMap(SqlClient.SqlClient, fn)

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
            withSql((sql) => returningStrategy.insertReturning<T>(sql, model, sqlData)),
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
          sortBy?: { field: string; direction: 'asc' | 'desc' }
          offset?: number
        }): Promise<T[]> => {
          const conditions = where ? toWhereConditions(where, getFieldName, model) : []

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
                const whereClause = yield* requireWhereClause(buildWhereClause(sql, conditions), 'UPDATE')

                const result = yield* returningStrategy.updateReturning<Record<string, unknown>>(
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
                const whereClause = yield* requireWhereClause(buildWhereClause(sql, conditions), 'UPDATE')

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

        delete: async ({ model, where }: { model: string; where: Required<Where>[] }): Promise<void> => {
          const conditions = toWhereConditions(where, getFieldName, model)

          return runAdapterEffect(
            withSql((sql) =>
              Effect.gen(function* () {
                const whereClause = yield* requireWhereClause(buildWhereClause(sql, conditions), 'DELETE')

                yield* sql`
                  DELETE FROM ${sql(model)}
                  WHERE ${whereClause}
                `
              }),
            ),
            runtime,
          )
        },

        deleteMany: async ({ model, where }: { model: string; where: Required<Where>[] }): Promise<number> => {
          const conditions = toWhereConditions(where, getFieldName, model)

          return runAdapterEffect(
            withSql((sql) =>
              Effect.gen(function* () {
                const whereClause = yield* requireWhereClause(buildWhereClause(sql, conditions), 'DELETE')

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

        count: async ({ model, where }: { model: string; where?: Required<Where>[] }): Promise<number> => {
          const conditions = where ? toWhereConditions(where, getFieldName, model) : []

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
      adapterId: 'effect-sql',
      adapterName: 'Effect SQL Adapter',
      supportsJSON: true,
      supportsDates: true,
      supportsBooleans: true,
      debugLogs: adapterConfig.debugLogs ?? false,
    },
    adapter: createCustomAdapter(),
  })
}
