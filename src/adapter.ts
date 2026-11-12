import type { BetterAuthOptions, DBAdapter } from 'better-auth'
import { createAdapterFactory, type DBAdapterDebugLogOption } from 'better-auth/adapters'
import { type Context, Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { type Dialect, detectDialect } from './dialect'
import { EffectSqlAdapterError } from './errors'

export interface EffectSqlAdapterOptions {
  /** Forwarded to better-auth's adapter factory. */
  readonly debugLogs?: DBAdapterDebugLogOption
}

export type EffectSqlAdapter = (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>

const notImplemented = (method: string) => (): Promise<never> =>
  Promise.reject(new EffectSqlAdapterError({ message: `${method} is not implemented yet` }))

const buildAdapter = (_dialect: Dialect, options: EffectSqlAdapterOptions): EffectSqlAdapter =>
  createAdapterFactory({
    config: {
      adapterId: 'effect-sql',
      adapterName: 'Effect SQL',
      debugLogs: options.debugLogs ?? false,
    },
    adapter: () => ({
      create: notImplemented('create'),
      findOne: notImplemented('findOne'),
      findMany: notImplemented('findMany'),
      update: notImplemented('update'),
      updateMany: notImplemented('updateMany'),
      delete: notImplemented('delete'),
      deleteMany: notImplemented('deleteMany'),
      count: notImplemented('count'),
    }),
  })

/** Creates the adapter from the current Effect context. Fails on unsupported dialects. */
export const make = (
  options: EffectSqlAdapterOptions = {},
): Effect.Effect<EffectSqlAdapter, EffectSqlAdapterError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dialect = yield* Effect.fromOption(detectDialect(sql)).pipe(
      Effect.mapError(
        () =>
          new EffectSqlAdapterError({
            message: `Unsupported SQL dialect (driver "${sql.driver}"). Supported: PostgreSQL, MySQL, SQLite.`,
          }),
      ),
    )
    return buildAdapter(dialect, options)
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
