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

const toSqlValue = (value: unknown): Primitive =>
  isPrimitive(value) ? value : String(value)

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
      return sql`${column} LIKE ${"%" + String(value) + "%"}`

    case "starts_with":
      return sql`${column} LIKE ${String(value) + "%"}`

    case "ends_with":
      return sql`${column} LIKE ${"%" + String(value)}`
  }
}

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
