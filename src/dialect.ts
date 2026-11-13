import { Effect, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import { adapterError, type EffectSqlAdapterError } from './errors'

export type Dialect = 'sqlite' | 'pg' | 'mysql'

/** From the client, so users never pass it. */
export const detectDialect = (sql: SqlClient.SqlClient): Option.Option<Dialect> =>
  sql.onDialectOrElse({
    sqlite: () => Option.some<Dialect>('sqlite'),
    pg: () => Option.some<Dialect>('pg'),
    mysql: () => Option.some<Dialect>('mysql'),
    orElse: () => Option.none(),
  })

export const dialectOf: Effect.Effect<Dialect, EffectSqlAdapterError, SqlClient.SqlClient> = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    Effect.mapError(Effect.fromOption(detectDialect(sql)), () =>
      adapterError(`Unsupported SQL dialect (driver "${sql.driver}"). Supported: PostgreSQL, MySQL, SQLite.`),
    ),
)

/** better-auth's factory flags: what is `false`, the factory converts (Date ↔ string, boolean ↔ 0/1, JSON). */
export interface DialectProfile {
  readonly supportsDates: boolean
  readonly supportsBooleans: boolean
  readonly supportsJSON: boolean
  readonly supportsArrays: boolean
  /** The database generates uuid ids. */
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
  // Plain objects can't be bound; parsed jsonb passes through the factory as is.
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
