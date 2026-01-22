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

const isSqlError = (error: unknown): error is SqlError =>
  error !== null &&
  typeof error === "object" &&
  "_tag" in error &&
  error._tag === "SqlError"

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
    message.includes("connection") ||
    message.includes("ECONNREFUSED") ||
    message.includes("timeout")
  ) {
    return new ConnectionError({
      message,
      originalCause: error,
    })
  }

  return new AdapterError({ message, originalCause: error })
}

export const runAdapterEffect = <A>(
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>,
): Promise<A> =>
  runtime.runPromise(
    effect.pipe(
      Effect.catchAll((error) => Effect.die(mapSqlError(error))),
    ),
  )
