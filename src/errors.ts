import { Data } from 'effect'

/** The adapter's own failures. Database errors stay the original `SqlError`. */
export class EffectSqlAdapterError extends Data.TaggedError('EffectSqlAdapterError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
