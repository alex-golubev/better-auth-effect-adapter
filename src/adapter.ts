import type { BetterAuthOptions, DBAdapter, DBTransactionAdapter } from 'better-auth'
import {
  type AdapterFactoryCustomizeAdapterCreator,
  type CleanedWhere,
  type CustomAdapter,
  createAdapterFactory,
  type DBAdapterDebugLogOption,
  type JoinConfig,
} from 'better-auth/adapters'
import { Array as Arr, type Context, Data, Effect, Option, pipe } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import { ambientContext, withContext } from './context'
import { type Dialect, detectDialect, dialectProfiles } from './dialect'
import { EffectSqlAdapterError } from './errors'
import { attachJoins } from './joins'
import * as Operations from './operations'
import { clientNames, idStrategyOf, renderSchema, schemaStatements } from './schema'
import { whereCondition } from './where'

export { type BoundAuth, bind, run } from './context'

export interface EffectSqlAdapterOptions {
  /** Forwarded to better-auth's adapter factory. */
  readonly debugLogs?: DBAdapterDebugLogOption
}

export type EffectSqlAdapter = (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>

/** Runs an adapter effect and hands the result to better-auth's Promise interface. */
type Runner = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>

type AdapterHelpers = Parameters<AdapterFactoryCustomizeAdapterCreator>[0]

type Transaction = <R>(callback: (trx: DBTransactionAdapter) => Promise<R>) => Promise<R>

/** Where `npx auth generate` writes the schema when no `--output` is given. */
const DEFAULT_SCHEMA_FILE = 'better-auth-schema.sql'

/** The factory's method signatures are generic over the row type; rows come from the database untyped. */
const rows = <T>(promise: Promise<unknown>): Promise<T> => promise as Promise<T>

const withJoins =
  (sql: SqlClient.SqlClient, join: JoinConfig | undefined) =>
  (parents: ReadonlyArray<Operations.Row>): Effect.Effect<ReadonlyArray<Operations.Row>, unknown> =>
    pipe(
      Option.fromUndefinedOr(join),
      Option.filter((config) => Object.keys(config).length > 0),
      Option.match({
        onNone: () => Effect.succeed(parents),
        onSome: (config) => attachJoins(sql, config, parents),
      }),
    )

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

      findOne: ({ model, modelKey, where, select, join }) =>
        rows(
          withSql((sql) =>
            pipe(
              columns(modelKey ?? model, select),
              Effect.flatMap((names) =>
                Operations.findOne(sql, { table: model, columns: names, where: condition(sql, where) }),
              ),
              Effect.flatMap((row) => withJoins(sql, join)(row === null ? [] : [row])),
              Effect.map((found) => Option.getOrNull(Arr.head(found))),
            ),
          ),
        ),

      findMany: ({ model, modelKey, where, select, sortBy, limit, offset, join }) =>
        rows(
          withSql((sql) =>
            Effect.gen(function* () {
              const names = yield* columns(modelKey ?? model, select)
              const sort = yield* Option.match(Option.fromUndefinedOr(sortBy), {
                onNone: () => Effect.succeedNone,
                onSome: ({ field, direction }) =>
                  Effect.map(column(modelKey ?? model, field), (name) => Option.some({ column: name, direction })),
              })
              const found = yield* Operations.findMany(
                sql,
                { table: model, columns: names, where: condition(sql, where) },
                { sort, limit, offset: Option.fromUndefinedOr(offset) },
              )
              return yield* withJoins(sql, join)(found)
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

      consumeOne: ({ model, where }) =>
        rows(withSql((sql) => Operations.consumeOne(sql, dialect, model, condition(sql, where)))),

      incrementOne: ({ model, where, increment, set }) =>
        rows(
          withSql((sql) => Operations.incrementOne(sql, dialect, model, condition(sql, where), increment, set ?? {})),
        ),

      count: ({ model, where }) => withSql((sql) => Operations.count(sql, model, condition(sql, where))),

      createSchema: ({ file, tables }) =>
        withSql((sql) =>
          Effect.map(
            schemaStatements(tables, {
              dialect,
              idStrategy: idStrategyOf(options),
              rename: clientNames(sql, dialect),
            }),
            (statements) => ({ code: renderSchema(statements), path: file ?? DEFAULT_SCHEMA_FILE }),
          ),
        ),
    }
  }

/** A rejection of better-auth's transaction callback, handed back to it unchanged after the rollback. */
class CallbackRejected extends Data.TaggedError('CallbackRejected')<{ readonly cause: unknown }> {}

/**
 * Runs `evaluate` inside `sql.withTransaction` on the ambient context. Inside an app
 * transaction (bridged with `run`) this becomes a savepoint on the app's connection.
 * Adapter calls made by `evaluate` see the transaction through the bridged context.
 */
const inTransaction = <A>(
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, CallbackRejected | SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.flatMap(Effect.context<SqlClient.SqlClient>(), (context) =>
        Effect.tryPromise({
          try: () => withContext(context, evaluate),
          catch: (cause) => new CallbackRejected({ cause }),
        }),
      ),
    ),
  )

const buildAdapter = (
  root: Context.Context<SqlClient.SqlClient>,
  dialect: Dialect,
  options: EffectSqlAdapterOptions,
): EffectSqlAdapter => {
  const runner: Runner = (effect) => Effect.runPromiseWith(ambientContext(root))(effect)
  const factory = (transaction: false | Transaction) =>
    createAdapterFactory({
      config: {
        adapterId: 'effect-sql',
        adapterName: 'Effect SQL',
        debugLogs: options.debugLogs ?? false,
        supportsNumericIds: true,
        ...dialectProfiles[dialect],
        transaction,
      },
      adapter: createCustomAdapter(runner, dialect),
    })
  return (authOptions) => {
    // Better-auth's own transactions; nesting is handled by better-auth (it reuses an open one).
    const transactional = factory(false)(authOptions)
    const transaction: Transaction = (callback) =>
      runner(
        inTransaction(() => callback(transactional)).pipe(
          // Better-auth (and its callers) expect the callback's own error, e.g. an APIError.
          Effect.catchTag('CallbackRejected', (rejected) => Effect.fail(rejected.cause)),
        ),
      )
    return factory(transaction)(authOptions)
  }
}

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
