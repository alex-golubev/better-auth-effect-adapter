import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Effect, Option, pipe } from 'effect'
import { SqlClient } from 'effect/sql'
import { AuthCallError } from './errors'

/** better-auth's Promise API drops the caller's Effect context and transaction; the adapter reads them back here. */
const storage = new AsyncLocalStorage<Context.Context<SqlClient.SqlClient>>()

export const withContext = <A>(
  context: Context.Context<SqlClient.SqlClient>,
  evaluate: () => PromiseLike<A>,
): Promise<A> => storage.run(context, () => Promise.resolve(evaluate()))

/** A caller on another database must not receive auth queries. */
export const ambientContext = (root: Context.Context<SqlClient.SqlClient>): Context.Context<SqlClient.SqlClient> =>
  pipe(
    Option.fromUndefinedOr(storage.getStore()),
    Option.filter((context) => Context.get(context, SqlClient.SqlClient) === Context.get(root, SqlClient.SqlClient)),
    Option.getOrElse(() => root),
  )

/**
 * Calls better-auth in the current context and `sql.withTransaction`. A plain `Effect.promise`
 * deadlocks on SQLite and escapes the transaction elsewhere.
 */
export const run = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, AuthCallError, SqlClient.SqlClient> =>
  Effect.flatMap(Effect.context<SqlClient.SqlClient>(), (context) =>
    Effect.tryPromise({ try: () => withContext(context, evaluate), catch: (cause) => new AuthCallError({ cause }) }),
  )

/** better-auth's API and handler, called through `run`. */
export interface BoundAuth<API> {
  readonly use: <A>(f: (api: API) => PromiseLike<A>) => Effect.Effect<A, AuthCallError, SqlClient.SqlClient>
  readonly handler: (request: Request) => Effect.Effect<Response, AuthCallError, SqlClient.SqlClient>
}

export const bind = <API>(auth: {
  readonly api: API
  readonly handler: (request: Request) => Promise<Response>
}): BoundAuth<API> => ({
  use: (f) => run(() => f(auth.api)),
  handler: (request) => run(() => auth.handler(request)),
})
