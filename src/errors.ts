import { Data } from 'effect'

/** The adapter's own failures. Database errors stay the original `SqlError`. */
export class EffectSqlAdapterError extends Data.TaggedError('EffectSqlAdapterError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const adapterError = (message: string): EffectSqlAdapterError => new EffectSqlAdapterError({ message })

/** A better-auth call made through `run` or `bind` rejected; `cause` is the rejection, e.g. better-auth's `APIError`. */
export class AuthCallError extends Data.TaggedError('AuthCallError')<{ readonly cause: unknown }> {}
