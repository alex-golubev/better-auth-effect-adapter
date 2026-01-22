import type { ManagedRuntime } from 'effect'
import { Data, Effect, Option, pipe } from 'effect'
import type { SqlClient } from '@effect/sql'
import type { SqlError } from '@effect/sql/SqlError'

export class AdapterError extends Data.TaggedError('AdapterError')<{
  readonly message: string
  readonly originalCause?: unknown
}> {}

export class ConstraintViolationError extends Data.TaggedError('ConstraintViolationError')<{
  readonly message: string
  readonly constraint?: string
  readonly originalCause?: unknown
}> {}

export class ConnectionError extends Data.TaggedError('ConnectionError')<{
  readonly message: string
  readonly originalCause?: unknown
}> {}

export type BetterAuthAdapterError = AdapterError | ConstraintViolationError | ConnectionError

/**
 * Determines if the given error is an instance of a SqlError.
 */
const isSqlError = (error: unknown): error is SqlError =>
  error !== null && typeof error === 'object' && '_tag' in error && error._tag === 'SqlError'

/**
 * Extracts a detailed error message from SQL error cause.
 * Uses Option monad for safe property access.
 */
const extractCauseMessage = (cause: unknown): Option.Option<string> =>
  pipe(
    cause,
    Option.liftPredicate((c): c is Error => c instanceof Error),
    Option.map((e) => e.message),
    Option.orElse(() =>
      pipe(
        cause,
        Option.liftPredicate((c): c is { message: unknown } => typeof c === 'object' && c !== null && 'message' in c),
        Option.map((c) => String(c.message)),
      ),
    ),
  )

/**
 * Builds a detailed error message by combining the base message with cause details.
 */
const buildDetailedMessage = (baseMessage: string, cause: unknown): string =>
  pipe(
    extractCauseMessage(cause),
    Option.filter((causeMsg) => !baseMessage.includes(causeMsg)),
    Option.map((causeMsg) => `${baseMessage}: ${causeMsg}`),
    Option.getOrElse(() => baseMessage),
  )

/**
 * Error pattern definition for declarative error matching.
 */
interface ErrorPattern {
  readonly patterns: readonly string[]
  readonly create: (message: string, error: unknown) => BetterAuthAdapterError
}

/**
 * Error patterns for matching SQL errors to specific error types.
 */
const errorPatterns: readonly ErrorPattern[] = [
  {
    patterns: ['UNIQUE constraint', 'duplicate key', 'Duplicate entry', 'violates unique constraint'],
    create: (message, error) =>
      new ConstraintViolationError({
        message,
        constraint: 'unique',
        originalCause: error,
      }),
  },
  {
    patterns: ['FOREIGN KEY constraint', 'foreign key constraint', 'violates foreign key'],
    create: (message, error) =>
      new ConstraintViolationError({
        message,
        constraint: 'foreign_key',
        originalCause: error,
      }),
  },
  {
    patterns: ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'connection refused', 'connection timeout', 'Connection lost'],
    create: (message, error) =>
      new ConnectionError({
        message,
        originalCause: error,
      }),
  },
]

/**
 * Matches an error message against patterns and returns the appropriate error.
 */
const matchErrorPattern = (message: string, error: unknown): BetterAuthAdapterError =>
  pipe(
    errorPatterns,
    (patterns) => patterns.find(({ patterns: p }) => p.some((pat) => message.includes(pat))),
    Option.fromNullable,
    Option.map(({ create }) => create(message, error)),
    Option.getOrElse(() => new AdapterError({ message, originalCause: error })),
  )

/**
 * Maps an unknown error to a specific `BetterAuthAdapterError` subtype based on the characteristics
 * of the error message or type. Provides specialized error handling for SQL-related errors.
 */
export const mapSqlError = (error: unknown): BetterAuthAdapterError =>
  pipe(
    error,
    Option.liftPredicate(isSqlError),
    Option.match({
      onNone: () =>
        new AdapterError({
          message: error instanceof Error ? error.message : 'Unknown error',
          originalCause: error,
        }),
      onSome: (sqlError) => {
        const baseMessage = sqlError.message ?? 'Unknown SQL error'
        const message = buildDetailedMessage(baseMessage, sqlError.cause)
        return matchErrorPattern(message, sqlError)
      },
    }),
  )

/**
 * Executes a given effect within a managed runtime environment tailored for SQL client operations.
 *
 * @template A The type of the value produced by the effect when successfully executed.
 * @template R The environment type (must include SqlClient.SqlClient).
 * @param effect The effect to be executed.
 * @param runtime The managed runtime that provides the context for executing the effect.
 * @returns A promise that resolves with the result of the effect when successful.
 */
export const runAdapterEffect = <A, R extends SqlClient.SqlClient>(
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
): Promise<A> =>
  runtime.runPromise(
    effect.pipe(Effect.catchAll((error) => Effect.die(mapSqlError(error)))) as Effect.Effect<A, never, R>,
  )
