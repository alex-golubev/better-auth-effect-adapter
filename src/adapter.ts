import { Effect, Option, pipe, Runtime } from 'effect'
import { SqlClient } from '@effect/sql'
import { createAdapterFactory, type Where, type JoinConfig } from 'better-auth/adapters'
import type { DBTransactionAdapter } from 'better-auth/types'
import type { WhereCondition } from './where-builder.js'
import { buildWhereClause } from './where-builder.js'
import { buildSelectColumns, buildOrderBy, buildLimitOffset, requireWhereClause } from './query-builder.js'
import { getReturningStrategy } from './returning.js'
import { resolveJoins } from './join-builder.js'
import { mapSqlError, runAdapterEffect } from './errors.js'
import { getAffectedRows, toSqlData } from './transforms.js'
import type { EffectSqlAdapterConfig } from './types.js'

/**
 * Transforms an array of `Where` objects into an array of `WhereCondition` objects.
 *
 * The function takes a list of `Where` objects and maps each object to a corresponding
 * `WhereCondition` by extracting and normalizing its properties. If the `operator` or
 * `connector` properties are not specified, it assigns default values of `'eq'` and `'AND'` respectively.
 *
 * @param {Required<Where>[]} where - An array of `Where` objects with all required properties.
 * @returns {WhereCondition[]} An array of transformed `WhereCondition` objects.
 */
const toWhereConditions = (where: Required<Where>[]): WhereCondition[] =>
  where.map((w) => ({
    field: w.field,
    value: w.value,
    operator: w.operator ?? 'eq',
    connector: w.connector ?? 'AND',
  }))

/**
 * Type for a function that runs an Effect and returns a Promise.
 * Abstracts over normal runtime execution vs transactional execution.
 */
type EffectRunner = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>

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

  const defaultRunner: EffectRunner = (effect) => runAdapterEffect(effect, runtime)

  const createCustomAdapter =
    (runEffect: EffectRunner) =>
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

          return runEffect(withSql((sql) => returningStrategy.insertReturning<T>(sql, model, sqlData)))
        },

        findOne: async <T>({
          model,
          where,
          select,
          join,
        }: {
          model: string
          where: Required<Where>[]
          select?: string[]
          join?: JoinConfig
        }): Promise<T | null> => {
          const conditions = toWhereConditions(where)

          return runEffect(
            withSql((sql) =>
              Effect.gen(function* () {
                const columns = buildSelectColumns(sql, select, getFieldName, model)
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

                return yield* pipe(
                  Option.fromNullable(result[0]),
                  Option.match({
                    onNone: () => Effect.succeed(null as T | null),
                    onSome: (row) =>
                      pipe(
                        Option.fromNullable(join),
                        Option.filter((j) => Object.keys(j).length > 0),
                        Option.match({
                          onNone: () => Effect.succeed(row as T),
                          onSome: (j) =>
                            Effect.map(
                              resolveJoins(sql, [row], j),
                              (resolved) => (resolved[0] as T | undefined) ?? null,
                            ),
                        }),
                      ),
                  }),
                )
              }),
            ),
          )
        },

        findMany: async <T>({
          model,
          where,
          limit,
          sortBy,
          offset,
          join,
        }: {
          model: string
          where?: Required<Where>[]
          limit: number
          sortBy?: { field: string; direction: 'asc' | 'desc' }
          offset?: number
          join?: JoinConfig
        }): Promise<T[]> => {
          const conditions = where ? toWhereConditions(where) : []

          return runEffect(
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

                return yield* pipe(
                  Option.fromNullable(join),
                  Option.filter((j) => Object.keys(j).length > 0 && results.length > 0),
                  Option.match({
                    onNone: () => Effect.succeed(results as T[]),
                    onSome: (j) => resolveJoins(sql, results, j) as Effect.Effect<T[], unknown>,
                  }),
                )
              }),
            ),
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
          const conditions = toWhereConditions(where)
          const sqlData = toSqlData(updateData as Record<string, unknown>)

          return runEffect(
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
          const conditions = toWhereConditions(where)
          const sqlData = toSqlData(updateData)

          return runEffect(
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
          )
        },

        delete: async ({ model, where }: { model: string; where: Required<Where>[] }): Promise<void> => {
          const conditions = toWhereConditions(where)

          return runEffect(
            withSql((sql) =>
              Effect.gen(function* () {
                const whereClause = yield* requireWhereClause(buildWhereClause(sql, conditions), 'DELETE')

                yield* sql`
                  DELETE FROM ${sql(model)}
                  WHERE ${whereClause}
                `
              }),
            ),
          )
        },

        deleteMany: async ({ model, where }: { model: string; where: Required<Where>[] }): Promise<number> => {
          const conditions = toWhereConditions(where)

          return runEffect(
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
          )
        },

        count: async ({ model, where }: { model: string; where?: Required<Where>[] }): Promise<number> => {
          const conditions = where ? toWhereConditions(where) : []

          return runEffect(
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
          )
        },

        options: adapterConfig,
      }
    }

  const baseConfig = {
    adapterId: 'effect-sql' as const,
    adapterName: 'Effect SQL Adapter',
    supportsJSON: true,
    supportsDates: true,
    supportsBooleans: true,
    debugLogs: adapterConfig.debugLogs ?? false,
  }

  let lazyOptions: unknown = null

  const factory = createAdapterFactory({
    config: {
      ...baseConfig,
      transaction: <T>(callback: (trx: DBTransactionAdapter) => Promise<T>): Promise<T> => {
        const txEffect = Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const txRuntime = yield* Effect.runtime<SqlClient.SqlClient>()

              const txRunner: EffectRunner = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
                Runtime.runPromise(txRuntime)(
                  effect.pipe(Effect.catchAll((error) => Effect.die(mapSqlError(error)))) as Effect.Effect<
                    A,
                    never,
                    SqlClient.SqlClient
                  >,
                )

              const txFactory = createAdapterFactory({
                config: baseConfig,
                adapter: createCustomAdapter(txRunner),
              })
              const txAdapter = txFactory(lazyOptions as Parameters<typeof txFactory>[0])

              return yield* Effect.promise(() => callback(txAdapter))
            }),
          ),
        )

        return runAdapterEffect(txEffect, runtime)
      },
    },
    adapter: createCustomAdapter(defaultRunner),
  })

  return ((options: Parameters<typeof factory>[0]) => {
    lazyOptions = options
    return factory(options)
  }) as typeof factory
}
