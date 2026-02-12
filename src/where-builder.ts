import { Option, pipe } from 'effect'
import type { SqlClient } from '@effect/sql'
import type { Fragment } from '@effect/sql/Statement'
import type { Primitive } from './types.js'
import { convertToSqlValue } from './transforms.js'

export interface WhereCondition {
  field: string
  value: string | number | boolean | string[] | number[] | Date | null
  operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'not_in' | 'contains' | 'starts_with' | 'ends_with'
  connector: 'AND' | 'OR'
}

/**
 * Escapes special characters in a string used within a SQL LIKE clause.
 */
const escapeLikePattern = (value: string): string => value.replace(/[%_\\]/g, '\\$&')

const LIKE_ESCAPE = "ESCAPE '\\'"

/**
 * Converts an input value into a SQL-compatible primitive value.
 * Delegates to convertToSqlValue to ensure consistent treatment of
 * booleans (→ 0/1) and Dates (→ ISO string) across WHERE and INSERT/UPDATE.
 */
const toSqlValue = (value: unknown): Primitive => convertToSqlValue(value) ?? null

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

  in: (sql, field, value) =>
    !Array.isArray(value) || value.length === 0
      ? sql`1 = 0`
      : sql`${sql(field)} IN ${sql.in(value as readonly Primitive[])}`,

  not_in: (sql, field, value) =>
    !Array.isArray(value) || value.length === 0
      ? sql`1 = 1`
      : sql`${sql(field)} NOT IN ${sql.in(value as readonly Primitive[])}`,

  contains: (sql, field, value) =>
    sql`${sql(field)} LIKE ${'%' + escapeLikePattern(String(value)) + '%'} ${sql.literal(LIKE_ESCAPE)}`,

  starts_with: (sql, field, value) =>
    sql`${sql(field)} LIKE ${escapeLikePattern(String(value)) + '%'} ${sql.literal(LIKE_ESCAPE)}`,

  ends_with: (sql, field, value) =>
    sql`${sql(field)} LIKE ${'%' + escapeLikePattern(String(value))} ${sql.literal(LIKE_ESCAPE)}`,
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
