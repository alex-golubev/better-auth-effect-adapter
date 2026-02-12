import { Option, pipe } from 'effect'
import type { SqlClient } from '@effect/sql'
import type { Fragment } from '@effect/sql/Statement'
import type { Primitive } from './types.js'
import { convertToSqlValue } from './transforms.js'

export interface WhereCondition {
  field: string
  value: string | number | boolean | string[] | number[] | boolean[] | Date[] | Date | null
  operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'not_in' | 'contains' | 'starts_with' | 'ends_with'
  connector: 'AND' | 'OR'
}

/**
 * Escapes special characters in a string used within a SQL LIKE clause.
 */
const LIKE_ESCAPE_CHAR = '!'
const LIKE_ESCAPE_LITERAL = `'${LIKE_ESCAPE_CHAR}'`
const escapeLikePattern = (value: string): string => value.replace(/[!%_]/g, `${LIKE_ESCAPE_CHAR}$&`)

/**
 * Converts an input value into a SQL-compatible primitive value.
 * Delegates to convertToSqlValue to ensure consistent treatment of
 * booleans (→ 0/1) and Dates (→ ISO string) across WHERE and INSERT/UPDATE.
 */
const toSqlValue = (value: unknown): Primitive => convertToSqlValue(value) ?? null

/**
 * Normalizes list values for IN / NOT IN clauses by converting each item
 * using the same rules as other SQL-bound values (booleans -> 0/1, dates -> ISO).
 */
const toSqlList = (value: WhereCondition['value']): readonly Primitive[] | null =>
  pipe(
    value,
    Option.liftPredicate(Array.isArray),
    Option.map((arr) =>
      arr.map((item) => convertToSqlValue(item)).filter((item): item is Primitive => item !== undefined),
    ),
    Option.filter((arr) => arr.length > 0),
    Option.getOrNull,
  )

const buildLikeFragment = (sql: SqlClient.SqlClient, field: string, pattern: string): Fragment =>
  sql`${sql(field)} LIKE ${pattern} ESCAPE ${sql.literal(LIKE_ESCAPE_LITERAL)}`

/**
 * Operator handler type for building SQL fragments.
 */
type OperatorHandler = (sql: SqlClient.SqlClient, field: string, value: WhereCondition['value']) => Fragment

/**
 * Declarative mapping of operators to their SQL fragment builders.
 */
const operatorHandlers: Record<WhereCondition['operator'], OperatorHandler> = {
  eq: (sql, field, value) => (value === null ? sql`${sql(field)} IS NULL` : sql`${sql(field)} = ${toSqlValue(value)}`),

  ne: (sql, field, value) =>
    value === null ? sql`${sql(field)} IS NOT NULL` : sql`${sql(field)} <> ${toSqlValue(value)}`,

  lt: (sql, field, value) => sql`${sql(field)} < ${toSqlValue(value)}`,

  lte: (sql, field, value) => sql`${sql(field)} <= ${toSqlValue(value)}`,

  gt: (sql, field, value) => sql`${sql(field)} > ${toSqlValue(value)}`,

  gte: (sql, field, value) => sql`${sql(field)} >= ${toSqlValue(value)}`,

  in: (sql, field, value) => {
    const values = toSqlList(value)
    return values === null ? sql`1 = 0` : sql`${sql(field)} IN ${sql.in(values)}`
  },

  not_in: (sql, field, value) => {
    const values = toSqlList(value)
    return values === null ? sql`1 = 1` : sql`${sql(field)} NOT IN ${sql.in(values)}`
  },

  contains: (sql, field, value) => buildLikeFragment(sql, field, `%${escapeLikePattern(String(value))}%`),

  starts_with: (sql, field, value) => buildLikeFragment(sql, field, `${escapeLikePattern(String(value))}%`),

  ends_with: (sql, field, value) => buildLikeFragment(sql, field, `%${escapeLikePattern(String(value))}`),
}

/**
 * Generates an SQL fragment based on a WhereCondition object.
 */
const whereToFragment = (sql: SqlClient.SqlClient, where: WhereCondition): Fragment =>
  operatorHandlers[where.operator](sql, where.field, where.value)

/**
 * Groups conditions by their connector type.
 */
const groupByConnector = (conditions: readonly WhereCondition[]): { and: WhereCondition[]; or: WhereCondition[] } =>
  conditions.reduce(
    (acc, condition) => {
      acc[condition.connector === 'AND' ? 'and' : 'or'].push(condition)
      return acc
    },
    { and: [] as WhereCondition[], or: [] as WhereCondition[] },
  )

/**
 * Builds SQL fragments for a group of conditions.
 */
const buildConditionFragments = (sql: SqlClient.SqlClient, conditions: WhereCondition[]): Fragment[] =>
  conditions.map((c) => whereToFragment(sql, c))

/**
 * Combines condition groups into a single WHERE clause fragment.
 */
const combineConditionGroups = (
  sql: SqlClient.SqlClient,
  groups: { and: WhereCondition[]; or: WhereCondition[] },
): Fragment | null =>
  pipe(
    [
      groups.and.length > 0 ? sql.and(buildConditionFragments(sql, groups.and)) : null,
      groups.or.length > 0 ? sql`(${sql.or(buildConditionFragments(sql, groups.or))})` : null,
    ],
    (parts) => parts.filter((p): p is Fragment => p !== null),
    Option.liftPredicate((parts) => parts.length > 0),
    Option.map((parts) => (parts.length === 1 ? parts[0]! : sql.and(parts))),
    Option.getOrNull,
  )

/**
 * Constructs a SQL WHERE clause fragment based on the provided conditions.
 */
export const buildWhereClause = (sql: SqlClient.SqlClient, conditions: readonly WhereCondition[]): Fragment | null =>
  pipe(
    conditions,
    Option.liftPredicate((c) => c.length > 0),
    Option.map((conds) => groupByConnector(conds)),
    Option.flatMap((groups) => Option.fromNullable(combineConditionGroups(sql, groups))),
    Option.getOrNull,
  )
