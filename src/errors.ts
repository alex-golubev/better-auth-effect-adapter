import { Data, Effect, ManagedRuntime } from "effect"
import type { SqlClient } from "@effect/sql"
import { SqlError } from "@effect/sql/SqlError"

export class AdapterError extends Data.TaggedError("AdapterError")<{
  readonly message: string
  readonly originalCause?: unknown
}> {}

export class ConstraintViolationError extends Data.TaggedError("ConstraintViolationError")<{
  readonly message: string
  readonly constraint?: string
  readonly originalCause?: unknown
}> {}

export class ConnectionError extends Data.TaggedError("ConnectionError")<{
  readonly message: string
  readonly originalCause?: unknown
}> {}

export type BetterAuthAdapterError =
  | AdapterError
  | ConstraintViolationError
  | ConnectionError

/**
 * Determines if the given error is an instance of a SqlError.
 *
 * This function performs a type guard check to verify whether the provided `error`
 * conforms to the structure of a SqlError. It ensures that the input is a non-null
 * object with a property `_tag` equal to the string `"SqlError"`.
 *
 * @param {unknown} error - The error object that needs to be checked.
 * @returns {boolean} - Returns `true` if the input is a SqlError; otherwise, `false`.
 */
const isSqlError = (error: unknown): error is SqlError =>
  error !== null &&
  typeof error === "object" &&
  "_tag" in error &&
  error._tag === "SqlError"

/**
 * Maps an unknown error to a specific `BetterAuthAdapterError` subtype based on the characteristics
 * of the error message or type. Provides specialized error handling for SQL-related errors.
 *
 * @param {unknown} error - The error to be evaluated and mapped. This can be any unknown value.
 * @returns {BetterAuthAdapterError} Returns a specific `BetterAuthAdapterError`, such as `ConstraintViolationError`,
 * `ConnectionError`, or a general `AdapterError` based on the type or message of the passed-in error.
 *
 * The mapping behavior includes:
 * - **Unique Constraint Violations**: Identifies SQL errors related to duplicate or unique constraints and maps them to `ConstraintViolationError` with `constraint: "unique"`.
 * - **Foreign Key Violations**: Identifies errors related to foreign key constraints and maps them to `ConstraintViolationError` with `constraint: "foreign_key"`.
 * - **Connection Issues**: Identifies errors related to failed connections, timeouts, or connection refusals and maps them to `ConnectionError`.
 * - **Fallback**: Defaults to an `AdapterError` for errors that cannot be categorized.
 */
export const mapSqlError = (error: unknown): BetterAuthAdapterError => {
  if (!isSqlError(error)) {
    return new AdapterError({
      message: error instanceof Error ? error.message : "Unknown error",
      originalCause: error,
    })
  }

  const message = error.message ?? "Unknown SQL error"

  if (
    message.includes("UNIQUE constraint") ||
    message.includes("duplicate key") ||
    message.includes("Duplicate entry") ||
    message.includes("violates unique constraint")
  ) {
    return new ConstraintViolationError({
      message,
      constraint: "unique",
      originalCause: error,
    })
  }

  if (
    message.includes("FOREIGN KEY constraint") ||
    message.includes("foreign key constraint") ||
    message.includes("violates foreign key")
  ) {
    return new ConstraintViolationError({
      message,
      constraint: "foreign_key",
      originalCause: error,
    })
  }

  if (
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ENOTFOUND") ||
    message.includes("connection refused") ||
    message.includes("connection timeout") ||
    message.includes("Connection lost")
  ) {
    return new ConnectionError({
      message,
      originalCause: error,
    })
  }

  return new AdapterError({ message, originalCause: error })
}

/**
 * Executes a given effect within a managed runtime environment tailored for SQL client operations.
 *
 * This method applies the effect using the provided `ManagedRuntime`, ensuring proper error handling
 * and resource management. If the effect encounters an error, it is caught, transformed into a fatal error
 * using `mapSqlError`, and rethrown.
 *
 * @template A The type of the value produced by the effect when successfully executed.
 * @param {Effect.Effect<A, unknown, SqlClient.SqlClient>} effect The effect to be executed, which may involve
 * interacting with a SQL client.
 * @param {ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>} runtime The managed runtime that provides
 * the context for executing the effect.
 * @returns {Promise<A>} A promise that resolves with the result of the effect when successful. If the effect fails,
 * the error is mapped and rethrown as a fatal runtime error.
 */
export const runAdapterEffect = <A>(
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>,
): Promise<A> =>
  runtime.runPromise(
    effect.pipe(
      Effect.catchAll((error) => Effect.die(mapSqlError(error))),
    ),
  )
