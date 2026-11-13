import { AsyncLocalStorage } from 'node:async_hooks'
import { type Cause, Context, Effect, Option, pipe } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * Carries the caller's Effect context — including an open `sql.withTransaction` — through
 * better-auth's Promise API down to the adapter, which has no other way to see it.
 */
const storage = new AsyncLocalStorage<Context.Context<SqlClient.SqlClient>>()

/** Runs `evaluate` so that adapter calls made inside it use `context`. */
export const withContext = <A>(
  context: Context.Context<SqlClient.SqlClient>,
  evaluate: () => PromiseLike<A>,
): Promise<A> => storage.run(context, () => Promise.resolve(evaluate()))

/**
 * The context an adapter call runs with: the caller's, when bridged by `run` and backed by
 * the adapter's own SqlClient, otherwise the context the adapter was created with.
 * A caller on another SqlClient (another database) must not receive auth queries.
 */
export const ambientContext = (root: Context.Context<SqlClient.SqlClient>): Context.Context<SqlClient.SqlClient> =>
  pipe(
    Option.fromUndefinedOr(storage.getStore()),
    Option.filter((context) => Context.get(context, SqlClient.SqlClient) === Context.get(root, SqlClient.SqlClient)),
    Option.getOrElse(() => root),
  )

/**
 * Calls better-auth (or anything that reaches the adapter) from Effect code so that its
 * queries run in the current context: on the same connection and inside the current
 * `sql.withTransaction`, if any. Required for auth calls inside an app transaction —
 * a plain `Effect.promise` deadlocks on SQLite and escapes the transaction elsewhere.
 *
 * Fails with `UnknownError` whose `cause` is the original rejection (e.g. better-auth's `APIError`).
 */
export const run = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, Cause.UnknownError, SqlClient.SqlClient> =>
  Effect.flatMap(Effect.context<SqlClient.SqlClient>(), (context) =>
    Effect.tryPromise(() => withContext(context, evaluate)),
  )

/** A better-auth instance whose API and handler run in the current Effect context (see `run`). */
export interface BoundAuth<API> {
  readonly use: <A>(f: (api: API) => PromiseLike<A>) => Effect.Effect<A, Cause.UnknownError, SqlClient.SqlClient>
  readonly handler: (request: Request) => Effect.Effect<Response, Cause.UnknownError, SqlClient.SqlClient>
}

export const bind = <API>(auth: {
  readonly api: API
  readonly handler: (request: Request) => Promise<Response>
}): BoundAuth<API> => ({
  use: (f) => run(() => f(auth.api)),
  handler: (request) => run(() => auth.handler(request)),
})
