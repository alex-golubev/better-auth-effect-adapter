import { Effect, ManagedRuntime } from "effect"
import type { SqlClient } from "@effect/sql"
import { SqlError } from "@effect/sql/SqlError"

export class AdapterError extends Error {
  readonly _tag = "AdapterError" as const
  readonly originalCause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "AdapterError"
    this.originalCause = cause
  }
}

export class ConstraintViolationError extends Error {
  readonly _tag = "ConstraintViolationError" as const
  readonly constraint: string | undefined
  readonly originalCause?: unknown

  constructor(message: string, constraint: string | undefined, cause?: unknown) {
    super(message)
    this.name = "ConstraintViolationError"
    this.constraint = constraint
    this.originalCause = cause
  }
}

export class ConnectionError extends Error {
  readonly _tag = "ConnectionError" as const
  readonly originalCause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "ConnectionError"
    this.originalCause = cause
  }
}

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
    return new AdapterError(
      error instanceof Error ? error.message : "Unknown error",
      error,
    )
  }

  const message = error.message ?? "Unknown SQL error"

  if (
    message.includes("UNIQUE constraint") ||
    message.includes("duplicate key") ||
    message.includes("Duplicate entry") ||
    message.includes("violates unique constraint")
  ) {
    return new ConstraintViolationError(
      "Unique constraint violation",
      undefined,
      error,
    )
  }

  if (
    message.includes("FOREIGN KEY constraint") ||
    message.includes("foreign key constraint") ||
    message.includes("violates foreign key")
  ) {
    return new ConstraintViolationError(
      "Foreign key constraint violation",
      undefined,
      error,
    )
  }

  if (
    message.includes("connection") ||
    message.includes("ECONNREFUSED") ||
    message.includes("timeout")
  ) {
    return new ConnectionError("Database connection error", error)
  }

  return new AdapterError(message, error)
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
