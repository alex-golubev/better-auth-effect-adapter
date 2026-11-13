import type { BetterAuthOptions, DBAdapter, DBTransactionAdapter } from 'better-auth'
import {
  type AdapterFactoryCustomizeAdapterCreator,
  type CleanedWhere,
  type CustomAdapter,
  createAdapterFactory,
  type DBAdapterDebugLogOption,
  type JoinConfig,
} from 'better-auth/adapters'
import { Array, Context, Data, Effect, Match, Option, Predicate, pipe, Record, Tracer } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import { ambientContext, withContext } from './context'
import { type Dialect, dialectOf, dialectProfiles } from './dialect'
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

type Runner = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>

type AdapterHelpers = Parameters<AdapterFactoryCustomizeAdapterCreator>[0]

type Transaction = <R>(callback: (trx: DBTransactionAdapter) => Promise<R>) => Promise<R>

/** Used by `npx auth generate` without `--output`. */
const DEFAULT_SCHEMA_FILE = 'better-auth-schema.sql'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && Array.contains([Object.prototype, null], Object.getPrototypeOf(value))

const toNumber = (value: unknown): unknown => (Predicate.isBigInt(value) ? Number(value) : value)

const columnsToNumbers = (value: unknown): unknown => (isPlainObject(value) ? Record.map(value, toNumber) : value)

/**
 * @effect/sql-pg returns int8 as a JS BigInt, which better-auth's number fields and JSON responses can't take.
 * Joined rows sit one level down, as a row or an array of rows; JSON contents can't hold BigInts.
 */
const rowToNumbers = (row: Record<string, unknown>): Record<string, unknown> =>
  Record.map(row, (value) =>
    Array.isArray(value) ? Array.map(value, columnsToNumbers) : toNumber(columnsToNumbers(value)),
  )

const withNumbers = (result: unknown): unknown =>
  Match.value(result).pipe(
    Match.when(Array.isArray, (rows) => Array.map(rows, (row) => (isPlainObject(row) ? rowToNumbers(row) : row))),
    Match.when(isPlainObject, rowToNumbers),
    Match.orElse((other) => other),
  )

const withJoins =
  (sql: SqlClient.SqlClient, join: JoinConfig | undefined) =>
  (parents: ReadonlyArray<Operations.Row>): Effect.Effect<ReadonlyArray<Operations.Row>, SqlError.SqlError> =>
    Option.match(Option.fromUndefinedOr(join), {
      onNone: () => Effect.succeed(parents),
      onSome: (config) => attachJoins(sql, config, parents),
    })

const createCustomAdapter =
  (run: Runner, dialect: Dialect) =>
  ({ getFieldName, options }: AdapterHelpers): CustomAdapter => {
    const withSql = <A, E>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
      run(Effect.flatMap(SqlClient.SqlClient, f))

    // The factory's methods are generic over the row type; database rows are untyped.
    const rows = <T>(f: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
      withSql((sql) => Effect.map(f(sql), withNumbers)) as Promise<T>

    // Only `select` and `sortBy` arrive as logical field names.
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
      create: ({ model, data }) => rows((sql) => Operations.create(sql, dialect, model, data)),

      findOne: ({ model, modelKey, where, select, join }) =>
        rows((sql) =>
          pipe(
            columns(modelKey ?? model, select),
            Effect.flatMap((names) =>
              Operations.findOne(sql, { table: model, columns: names, where: condition(sql, where) }),
            ),
            Effect.flatMap((row) => withJoins(sql, join)(Option.toArray(Option.fromNullOr(row)))),
            Effect.map(Operations.firstOrNull),
          ),
        ),

      findMany: ({ model, modelKey, where, select, sortBy, limit, offset, join }) =>
        rows((sql) =>
          Effect.gen(function* () {
            const names = yield* columns(modelKey ?? model, select)
            const sort = yield* Option.match(Option.fromUndefinedOr(sortBy), {
              onNone: () => Effect.succeedNone,
              onSome: ({ field, direction }) =>
                Effect.map(column(modelKey ?? model, field), (name) => Option.some({ column: name, direction })),
            })
            const found = yield* Operations.findMany(
              sql,
              dialect,
              { table: model, columns: names, where: condition(sql, where) },
              { sort, limit, offset: Option.fromUndefinedOr(offset) },
            )
            return yield* withJoins(sql, join)(found)
          }),
        ),

      update: ({ model, where, update }) =>
        rows((sql) => Operations.update(sql, dialect, model, condition(sql, where), update as Operations.Row)),

      updateMany: ({ model, where, update }) =>
        withSql((sql) => Operations.updateMany(sql, model, condition(sql, where), update)),

      delete: ({ model, where }) => withSql((sql) => Operations.remove(sql, model, condition(sql, where))),

      deleteMany: ({ model, where }) => withSql((sql) => Operations.removeMany(sql, model, condition(sql, where))),

      consumeOne: ({ model, where }) =>
        rows((sql) => Operations.consumeOne(sql, dialect, model, condition(sql, where))),

      incrementOne: ({ model, where, increment, set }) =>
        rows((sql) => Operations.incrementOne(sql, dialect, model, condition(sql, where), increment, set ?? {})),

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

class CallbackRejected extends Data.TaggedError('CallbackRejected')<{ readonly cause: unknown }> {}

/** A savepoint inside an app transaction. The callback's adapter calls see it only through `withContext`. */
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
    // better-auth never nests transactions, so the callback's adapter needs none.
    const transactional = factory(false)(authOptions)
    const transaction: Transaction = (callback) =>
      runner(
        inTransaction(() => callback(transactional)).pipe(
          // better-auth expects the callback's own error back, e.g. an APIError.
          Effect.catchTag('CallbackRejected', (rejected) => Effect.fail(rejected.cause)),
        ),
      )
    return factory(transaction)(authOptions)
  }
}

/** The adapter for the SqlClient in context. Fails on unsupported dialects. */
export const make = (
  options: EffectSqlAdapterOptions = {},
): Effect.Effect<EffectSqlAdapter, EffectSqlAdapterError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const dialect = yield* dialectOf
    const sql = yield* SqlClient.SqlClient
    // A transaction or span open around `make` ends long before the adapter's queries run.
    const context = Context.omit(
      sql.transactionService,
      Tracer.ParentSpan,
    )(yield* Effect.context<SqlClient.SqlClient>())
    return buildAdapter(context, dialect, options)
  })

/** `make` for apps outside Effect, e.g. with `await runtime.context()`. Throws on unsupported dialects. */
export const fromContext = (
  context: Context.Context<SqlClient.SqlClient>,
  options: EffectSqlAdapterOptions = {},
): EffectSqlAdapter => Effect.runSync(Effect.provideContext(make(options), context))
