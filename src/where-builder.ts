import type { SqlClient } from "@effect/sql"
import type { Fragment, Primitive } from "@effect/sql/Statement"

export interface WhereCondition {
  field: string
  value: string | number | boolean | string[] | number[] | Date | null
  operator:
    | "eq"
    | "ne"
    | "lt"
    | "lte"
    | "gt"
    | "gte"
    | "in"
    | "not_in"
    | "contains"
    | "starts_with"
    | "ends_with"
  connector: "AND" | "OR"
}

const isPrimitive = (value: unknown): value is Primitive =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint" ||
  typeof value === "boolean" ||
  value instanceof Date ||
  value instanceof Int8Array ||
  value instanceof Uint8Array

/**
 * Escapes special characters in a string used within a SQL LIKE clause.
 *
 * Escapes the `%`, `_`, and `\` characters by prefixing them with a backslash (`\`)
 * to ensure they are treated as literal characters rather than special pattern
 * matching operators in SQL.
 *
 * @param {string} value - The input string to escape.
 * @returns {string} The escaped string safe for use in a SQL LIKE clause.
 */
const escapeLikePattern = (value: string): string =>
  value.replace(/[%_\\]/g, "\\$&")

/**
 * Converts an input value into a SQL-compatible primitive value.
 * If the input is already a primitive, it is returned unchanged.
 * Otherwise, the value is coerced into a string representation.
 *
 * @param {unknown} value - The value to be converted.
 * @returns {Primitive} The SQL-compatible primitive representation of the input.
 */
const toSqlValue = (value: unknown): Primitive =>
  isPrimitive(value) ? value : String(value)

/**
 * Generates an SQL fragment based on a `WhereCondition` object.
 * The function processes a condition, including the field, operator, and value,
 * and constructs the corresponding SQL query fragment.
 *
 * @param {SqlClient.SqlClient} sql - An instance of the SQL client,
 *     used to construct the SQL query fragment.
 * @param {WhereCondition} where - An object representing the condition for the "WHERE" clause.
 *     This includes the field to compare, the operator to use, and the value to compare against.
 * @returns {Fragment} A SQL fragment representing the constructed condition.
 *
 * Supported `WhereCondition.operator` values:
 * - "eq": Generates a condition for equality. Handles `NULL` values appropriately.
 * - "ne": Generates a condition for inequality. Handles `NULL` values appropriately.
 * - "lt": Generates a condition for less than comparison.
 * - "lte": Generates a condition for less than or equal comparison.
 * - "gt": Generates a condition for greater than comparison.
 * - "gte": Generates a condition for greater than or equal comparison.
 * - "in": Generates a condition for inclusion in a list of values. Returns a "false" fragment if the list is empty.
 * - "not_in": Generates a condition for exclusion from a list of values. Returns a "true" fragment if the list is empty.
 * - "contains": Generates a condition for checking if the field contains a specified substring.
 * - "starts_with": Generates a condition for checking if the field starts with a specified substring.
 * - "ends_with": Generates a condition for checking if the field ends with a specified substring.
 *
 * Notes:
 * - For "in" and "not_in" operators, the value must be an array.
 * - For "contains", "starts_with", and "ends_with" operators, the value is escaped to handle SQL "LIKE" patterns.
 */
const whereToFragment = (
  sql: SqlClient.SqlClient,
  where: WhereCondition,
): Fragment => {
  const column = sql(where.field)
  const value = where.value

  switch (where.operator) {
    case "eq":
      return value === null
        ? sql`${column} IS NULL`
        : sql`${column} = ${toSqlValue(value)}`

    case "ne":
      return value === null
        ? sql`${column} IS NOT NULL`
        : sql`${column} <> ${toSqlValue(value)}`

    case "lt":
      return sql`${column} < ${toSqlValue(value)}`

    case "lte":
      return sql`${column} <= ${toSqlValue(value)}`

    case "gt":
      return sql`${column} > ${toSqlValue(value)}`

    case "gte":
      return sql`${column} >= ${toSqlValue(value)}`

    case "in":
      return !Array.isArray(value) || value.length === 0
        ? sql`1 = 0`
        : sql`${column} IN ${sql.in(value as readonly Primitive[])}`

    case "not_in":
      return !Array.isArray(value) || value.length === 0
        ? sql`1 = 1`
        : sql`${column} NOT IN ${sql.in(value as readonly Primitive[])}`

    case "contains":
      return sql`${column} LIKE ${"%" + escapeLikePattern(String(value)) + "%"}`

    case "starts_with":
      return sql`${column} LIKE ${escapeLikePattern(String(value)) + "%"}`

    case "ends_with":
      return sql`${column} LIKE ${"%" + escapeLikePattern(String(value))}`
  }
}

/**
 * Constructs a SQL `WHERE` clause fragment based on the provided conditions.
 *
 * @param {SqlClient.SqlClient} sql - An instance of the SQL client used for building SQL fragments.
 * @param {readonly WhereCondition[]} conditions - A list of conditions to include in the `WHERE` clause.
 *         Each condition specifies its connector type ("AND" or "OR") and the query logic.
 * @returns {Fragment | null} A SQL fragment representing the `WHERE` clause, or `null` if no conditions are provided.
 */
export const buildWhereClause = (
  sql: SqlClient.SqlClient,
  conditions: readonly WhereCondition[],
): Fragment | null => {
  if (conditions.length === 0) {
    return null
  }

  const andConditions = conditions
    .filter((c) => c.connector === "AND")
    .map((c) => whereToFragment(sql, c))

  const orConditions = conditions
    .filter((c) => c.connector === "OR")
    .map((c) => whereToFragment(sql, c))

  const parts = [
    andConditions.length > 0 ? sql.and(andConditions) : null,
    orConditions.length > 0 ? sql`(${sql.or(orConditions)})` : null,
  ].filter((p): p is Fragment => p !== null)

  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  return sql.and(parts)
}
