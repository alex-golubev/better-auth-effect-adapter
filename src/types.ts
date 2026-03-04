import type { Runtime } from 'effect'
import type { SqlClient } from '@effect/sql'
import type { Fragment } from '@effect/sql/Statement'

/**
 * Primitive SQL value types.
 * Defined locally since @effect/sql@0.49+ no longer exports this type.
 */
export type Primitive = null | string | number | bigint | boolean | Date | Int8Array | Uint8Array

export type Dialect = 'pg' | 'mysql' | 'sqlite'

/**
 * Represents a record of SQL-compatible data values.
 * Used for INSERT and UPDATE operations.
 */
export type SqlData = Record<string, Primitive | Fragment | undefined>

/**
 * Configuration for the Effect SQL adapter.
 *
 * @template R - The environment type provided by the runtime (must include SqlClient.SqlClient)
 */
export interface EffectSqlAdapterConfig<R extends SqlClient.SqlClient = SqlClient.SqlClient> {
  /**
   * Runtime that provides SqlClient.
   *
   * Can be obtained via `Effect.runtime<SqlClient.SqlClient>()` inside a Layer
   * (for single-pool sharing), or from `await ManagedRuntime.make(layer).runtime()`.
   *
   * The runtime must provide at least SqlClient.SqlClient in its environment.
   * It can provide additional services (e.g., PgClient).
   */
  runtime: Runtime.Runtime<R>

  /**
   * Database dialect for handling SQL differences (e.g., RETURNING clause).
   * - "pg": PostgreSQL
   * - "mysql": MySQL
   * - "sqlite": SQLite
   */
  dialect: Dialect

  /**
   * Enable debug logging for adapter operations.
   * When enabled, better-auth logs all database queries.
   * @default false
   */
  debugLogs?: boolean
}

export type { SqlClient } from '@effect/sql'
