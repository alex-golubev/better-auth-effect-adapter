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
