import type { BetterAuthOptions, DBAdapter } from 'better-auth'
import {
  type AdapterFactoryCustomizeAdapterCreator,
  type CleanedWhere,
  type CustomAdapter,
  createAdapterFactory,
  type DBAdapterDebugLogOption,
} from 'better-auth/adapters'
import { type Context, Effect, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import { type Dialect, detectDialect, dialectProfiles } from './dialect'
import { EffectSqlAdapterError } from './errors'
import * as Operations from './operations'
import { idStrategyOf, renderSchema, schemaStatements } from './schema'
import { whereCondition } from './where'

export interface EffectSqlAdapterOptions {
  /** Forwarded to better-auth's adapter factory. */
  readonly debugLogs?: DBAdapterDebugLogOption
}

export type EffectSqlAdapter = (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>

/** Runs an adapter effect and hands the result to better-auth's Promise interface. */
type Runner = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>

type AdapterHelpers = Parameters<AdapterFactoryCustomizeAdapterCreator>[0]

/** Where `npx auth generate` writes the schema when no `--output` is given. */
const DEFAULT_SCHEMA_FILE = 'better-auth-schema.sql'

/** The factory's method signatures are generic over the row type; rows come from the database untyped. */
const rows = <T>(promise: Promise<unknown>): Promise<T> => promise as Promise<T>

const createCustomAdapter =
  (run: Runner, dialect: Dialect) =>
  ({ getFieldName, options }: AdapterHelpers): CustomAdapter => {
    const withSql = <A, E>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
      run(Effect.flatMap(SqlClient.SqlClient, f))

    // `select` and `sortBy` arrive as logical field names; where fields and data keys are already physical.
    const column = (model: string, field: string) =>
      Effect.try({
        try: () => getFieldName({ model, field }),
        catch: (cause) => new EffectSqlAdapterError({ message: `Unknown field "${field}" on "${model}"`, cause }),
      })

    const columns = (model: string, select: ReadonlyArray<string> | undefined) =>
      Effect.forEach(select ?? [], (field) => column(model, field))

    const condition = (sql: SqlClient.SqlClient, where: ReadonlyArray<CleanedWhere> | undefined) =>
      whereCondition(sql, dialect, where ?? [])

    return {
      create: ({ model, data }) => rows(withSql((sql) => Operations.create(sql, dialect, model, data))),

      findOne: ({ model, modelKey, where, select }) =>
        rows(
          withSql((sql) =>
            Effect.flatMap(columns(modelKey ?? model, select), (names) =>
              Operations.findOne(sql, { table: model, columns: names, where: condition(sql, where) }),
            ),
          ),
        ),

      findMany: ({ model, modelKey, where, select, sortBy, limit, offset }) =>
        rows(
          withSql((sql) =>
            Effect.gen(function* () {
              const names = yield* columns(modelKey ?? model, select)
              const sort = yield* Option.match(Option.fromUndefinedOr(sortBy), {
                onNone: () => Effect.succeedNone,
                onSome: ({ field, direction }) =>
                  Effect.map(column(modelKey ?? model, field), (name) => Option.some({ column: name, direction })),
              })
              return yield* Operations.findMany(
                sql,
                { table: model, columns: names, where: condition(sql, where) },
                { sort, limit, offset: Option.fromUndefinedOr(offset) },
              )
            }),
          ),
        ),

      update: ({ model, where, update }) =>
        rows(withSql((sql) => Operations.update(sql, dialect, model, condition(sql, where), update as Operations.Row))),

      updateMany: ({ model, where, update }) =>
        withSql((sql) => Operations.updateMany(sql, dialect, model, condition(sql, where), update)),

      delete: ({ model, where }) => withSql((sql) => Operations.remove(sql, model, condition(sql, where))),

      deleteMany: ({ model, where }) =>
        withSql((sql) => Operations.removeMany(sql, dialect, model, condition(sql, where))),

      count: ({ model, where }) => withSql((sql) => Operations.count(sql, model, condition(sql, where))),

      createSchema: ({ file, tables }) =>
        run(
          Effect.map(schemaStatements(tables, { dialect, idStrategy: idStrategyOf(options) }), (statements) => ({
            code: renderSchema(statements),
            path: file ?? DEFAULT_SCHEMA_FILE,
          })),
        ),
    }
  }

const buildAdapter = (
  context: Context.Context<SqlClient.SqlClient>,
  dialect: Dialect,
  options: EffectSqlAdapterOptions,
): EffectSqlAdapter =>
  createAdapterFactory({
    config: {
      adapterId: 'effect-sql',
      adapterName: 'Effect SQL',
      debugLogs: options.debugLogs ?? false,
      supportsNumericIds: true,
      ...dialectProfiles[dialect],
    },
    adapter: createCustomAdapter((effect) => Effect.runPromiseWith(context)(effect), dialect),
  })

/** Creates the adapter from the current Effect context. Fails on unsupported dialects. */
export const make = (
  options: EffectSqlAdapterOptions = {},
): Effect.Effect<EffectSqlAdapter, EffectSqlAdapterError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<SqlClient.SqlClient>()
    const sql = yield* SqlClient.SqlClient
    const dialect = yield* Effect.fromOption(detectDialect(sql)).pipe(
      Effect.mapError(
        () =>
          new EffectSqlAdapterError({
            message: `Unsupported SQL dialect (driver "${sql.driver}"). Supported: PostgreSQL, MySQL, SQLite.`,
          }),
      ),
    )
    return buildAdapter(context, dialect, options)
  })

/**
 * Synchronous variant for apps without Effect layers, from a captured context such as
 * `await ManagedRuntime.make(PgClient.layer(...)).context()`.
 * Throws `EffectSqlAdapterError` on unsupported dialects.
 */
export const fromContext = (
  context: Context.Context<SqlClient.SqlClient>,
  options: EffectSqlAdapterOptions = {},
): EffectSqlAdapter => Effect.runSync(Effect.provideContext(make(options), context))
