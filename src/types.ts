import type { ManagedRuntime } from "effect"
import type { SqlClient } from "@effect/sql"
import type { Fragment, Primitive } from "@effect/sql/Statement"

export type Dialect = "pg" | "mysql" | "sqlite"

/**
 * Represents a record of SQL-compatible data values.
 * Used for INSERT and UPDATE operations.
 */
export type SqlData = Record<string, Primitive | Fragment | undefined>

export interface EffectSqlAdapterConfig {
  /**
   * ManagedRuntime that provides SqlClient.
   * Create this with ManagedRuntime.make(YourSqlLayer)
   */
  runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>

  /**
   * Database dialect for handling SQL differences (e.g., RETURNING clause).
   * - "pg": PostgreSQL
   * - "mysql": MySQL
   * - "sqlite": SQLite
   */
  dialect: Dialect

  /**
   * Enable debug logging.
   * @default false
   */
  debugLogs?: boolean
}

export type { SqlClient } from "@effect/sql"
