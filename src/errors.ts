import { Data } from 'effect'

/**
 * Raised for problems of the adapter itself (unsupported dialect, invalid schema, …).
 * Database failures are not wrapped: they surface as the original `SqlError`.
 */
export class EffectSqlAdapterError extends Data.TaggedError('EffectSqlAdapterError')<{
  readonly message: string
  readonly cause?: unknown
}> {}
