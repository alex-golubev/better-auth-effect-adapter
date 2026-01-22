import type { SqlClient } from "@effect/sql"
import type { Fragment, Primitive } from "@effect/sql/Statement"

export interface WhereCondition {
  field: string
  value: string | number | boolean | string[] | number[] | Date | null
  operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "not_in" | "contains" | "starts_with" | "ends_with"
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

const whereToFragment = (
  sql: SqlClient.SqlClient,
  where: WhereCondition,
): Fragment => {
  const column = sql(where.field)
  const value = where.value
  const operator = where.operator

  switch (operator) {
    case "eq":
      if (value === null) {
        return sql`${column} IS NULL`
      }
      if (isPrimitive(value)) {
        return sql`${column} = ${value}`
      }
      return sql`${column} = ${String(value)}`

    case "ne":
      if (value === null) {
        return sql`${column} IS NOT NULL`
      }
      if (isPrimitive(value)) {
        return sql`${column} <> ${value}`
      }
      return sql`${column} <> ${String(value)}`

    case "lt":
      if (isPrimitive(value)) {
        return sql`${column} < ${value}`
      }
      return sql`${column} < ${String(value)}`

    case "lte":
      if (isPrimitive(value)) {
        return sql`${column} <= ${value}`
      }
      return sql`${column} <= ${String(value)}`

    case "gt":
      if (isPrimitive(value)) {
        return sql`${column} > ${value}`
      }
      return sql`${column} > ${String(value)}`

    case "gte":
      if (isPrimitive(value)) {
        return sql`${column} >= ${value}`
      }
      return sql`${column} >= ${String(value)}`

    case "in":
      if (!Array.isArray(value) || value.length === 0) {
        return sql`1 = 0`
      }
      return sql`${sql.in(where.field, value as readonly Primitive[])}`

    case "not_in":
      if (!Array.isArray(value) || value.length === 0) {
        return sql`1 = 1`
      }
      return sql`${column} NOT IN ${sql.in(value as readonly Primitive[])}`

    case "contains":
      return sql`${column} LIKE ${"%" + String(value) + "%"}`

    case "starts_with":
      return sql`${column} LIKE ${String(value) + "%"}`

    case "ends_with":
      return sql`${column} LIKE ${"%" + String(value)}`

    default: {
      throw new Error(`Unknown operator: ${operator}`)
    }
  }
}

export const buildWhereClause = (
  sql: SqlClient.SqlClient,
  conditions: readonly WhereCondition[],
): Fragment | null => {
  if (conditions.length === 0) {
    return null
  }

  const andConditions: Fragment[] = []
  const orConditions: Fragment[] = []

  for (const condition of conditions) {
    const fragment = whereToFragment(sql, condition)

    if (condition.connector === "OR") {
      orConditions.push(fragment)
    } else {
      andConditions.push(fragment)
    }
  }

  const parts: Fragment[] = []

  if (andConditions.length > 0) {
    parts.push(sql.and(andConditions))
  }

  if (orConditions.length > 0) {
    parts.push(sql`(${sql.or(orConditions)})`)
  }

  if (parts.length === 0) {
    return null
  }

  if (parts.length === 1) {
    return parts[0]!
  }

  return sql.and(parts)
}
