import { Option } from 'effect'
import type { SqlClient } from 'effect/sql'

/** SQL dialects the adapter supports. */
export type Dialect = 'sqlite' | 'pg' | 'mysql'

/**
 * Detects the dialect from the SqlClient itself, so users never pass it explicitly.
 * `None` for dialects the adapter does not support (mssql, clickhouse).
 */
export const detectDialect = (sql: SqlClient.SqlClient): Option.Option<Dialect> =>
  sql.onDialectOrElse({
    sqlite: () => Option.some<Dialect>('sqlite'),
    pg: () => Option.some<Dialect>('pg'),
    mysql: () => Option.some<Dialect>('mysql'),
    orElse: () => Option.none(),
  })

/**
 * What each driver binds and returns natively. These are better-auth's factory flags:
 * whatever is `false` the factory converts (Date ↔ ISO string, boolean ↔ 0/1, JSON ↔ string).
 */
export interface DialectProfile {
  readonly supportsDates: boolean
  readonly supportsBooleans: boolean
  readonly supportsJSON: boolean
  readonly supportsArrays: boolean
  /** The database generates uuid ids itself (`DEFAULT gen_random_uuid()`). */
  readonly supportsUUIDs: boolean
}

export const dialectProfiles: Record<Dialect, DialectProfile> = {
  // node:sqlite can't bind Date or plain objects, and stores booleans as integers.
  sqlite: {
    supportsDates: false,
    supportsBooleans: false,
    supportsJSON: false,
    supportsArrays: false,
    supportsUUIDs: false,
  },
  // Plain objects can't be bound as parameters; jsonb comes back parsed, which the factory passes through.
  pg: {
    supportsDates: true,
    supportsBooleans: true,
    supportsJSON: false,
    supportsArrays: false,
    supportsUUIDs: true,
  },
  // BOOLEAN is TINYINT(1) and comes back as 0/1.
  mysql: {
    supportsDates: true,
    supportsBooleans: false,
    supportsJSON: false,
    supportsArrays: false,
    supportsUUIDs: false,
  },
}
