import { Effect } from 'effect'
import type { SqlClient } from '@effect/sql'
import type { Fragment } from '@effect/sql/Statement'

/**
 * Constructs a SQL fragment for the SELECT columns in a query.
 *
 * @param {SqlClient.SqlClient} sql - An instance of the SQL client used to build SQL fragments.
 * @param {string[] | undefined} select - An array of column names to include in the SELECT statement. If undefined or empty, selects all columns.
 * @param {function} getFieldName - A function that resolves the database field name given a model and field name.
 * @param {string} model - The name of the database model to use for resolving field names.
 * @returns {Fragment} A SQL fragment representing the SELECT columns.
 */
export const buildSelectColumns = (
  sql: SqlClient.SqlClient,
  select: string[] | undefined,
  getFieldName: (opts: { model: string; field: string }) => string,
  model: string,
): Fragment => {
  if (!select?.length) return sql.literal('*')
  const columns = select.map((col) => sql`${sql(getFieldName({ model, field: col }))}`)
  return sql.join(', ', false, '*')(columns)
}

/**
 * Constructs an SQL `ORDER BY` clause based on the specified sorting parameters.
 *
 * @param {SqlClient.SqlClient} sql - The SQL client instance used for escaping and building SQL fragments.
 * @param {{ field: string; direction: 'asc' | 'desc' } | undefined} sortBy - Sorting parameters defining the field to sort by and the direction (ascending or descending). If undefined, an empty string fragment is returned.
 * @param {(opts: { model: string; field: string }) => string} getFieldName - A function that determines the fully qualified field name based on the model and field parameters.
 * @param {string} model - Name of the database model associated with the field to be sorted.
 * @returns {Fragment} A SQL fragment representing the `ORDER BY` clause or an empty fragment if no sorting parameters are defined.
 */
export const buildOrderBy = (
  sql: SqlClient.SqlClient,
  sortBy: { field: string; direction: 'asc' | 'desc' } | undefined,
  getFieldName: (opts: { model: string; field: string }) => string,
  model: string,
): Fragment => {
  if (!sortBy) return sql.literal('')
  const field = sql(getFieldName({ model, field: sortBy.field }))
  const direction = sortBy.direction === 'desc' ? sql.literal('DESC') : sql.literal('ASC')
  return sql`ORDER BY ${field} ${direction}`
}

/**
 * Generates a SQL fragment for applying a LIMIT clause, with an optional OFFSET clause.
 *
 * @param {SqlClient.SqlClient} sql - The SQL client instance used to construct the SQL fragment.
 * @param {number} limit - The maximum number of rows to return.
 * @param {number} [offset] - The starting row number for the query result. If not provided, the OFFSET clause is omitted.
 * @returns {Fragment} The constructed SQL fragment representing the LIMIT and OFFSET clauses.
 */
export const buildLimitOffset = (sql: SqlClient.SqlClient, limit: number, offset?: number): Fragment =>
  offset ? sql`LIMIT ${limit} OFFSET ${offset}` : sql`LIMIT ${limit}`

/**
 * Ensures the presence of a WHERE clause and returns an Effect based on its existence.
 *
 * This function checks whether the provided `clause` argument is not null.
 * If the `clause` is provided, it wraps the `clause` in a successful `Effect`.
 * If the `clause` is null, the function throws an error indicating that the
 * specified `operation` requires a WHERE clause.
 *
 * @param clause - The optional WHERE clause fragment. If null, an error is thrown.
 * @param operation - A string describing the operation that requires the WHERE clause.
 * @returns An `Effect` that succeeds with the provided `clause` or fails with an error if the `clause` is null.
 */
export const requireWhereClause = (
  clause: Fragment | null,
  operation: string,
): Effect.Effect<Fragment, never, never> =>
  clause ? Effect.succeed(clause) : Effect.die(new Error(`${operation} requires WHERE clause`))
