import type { ManagedRuntime } from "effect"
import type { SqlClient } from "@effect/sql"

export type Dialect = "pg" | "mysql" | "sqlite"

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
