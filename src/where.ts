import type { CleanedWhere, WhereOperator } from 'better-auth/adapters'
import { Array, Match, Option, Predicate, pipe, String } from 'effect'
import type { SqlClient, Statement } from 'effect/sql'
import { type Dialect, type DialectProfile, dialectProfiles } from './dialect'

type Fragment = Statement.Fragment

interface Condition {
  readonly sql: SqlClient.SqlClient
  readonly dialect: Dialect
  readonly column: Fragment
  readonly value: CleanedWhere['value']
  readonly insensitive: boolean
}

/** The factory converts single where values, but not the elements of `in`/`not_in` arrays. */
export const toSqlValue =
  (profile: DialectProfile) =>
  (value: unknown): unknown =>
    Match.value(value).pipe(
      Match.when(Predicate.isDate, (date) => (profile.supportsDates ? date : date.toISOString())),
      Match.when(Predicate.isBoolean, (bool) => (profile.supportsBooleans ? bool : Number(bool))),
      Match.orElse((other) => other),
    )

const scalar = (condition: Condition): unknown => toSqlValue(dialectProfiles[condition.dialect])(condition.value)

const list = (condition: Condition): ReadonlyArray<unknown> =>
  Array.map(
    Array.isArray(condition.value) ? condition.value : [condition.value],
    toSqlValue(dialectProfiles[condition.dialect]),
  )

const lowered = ({ sql, column }: Condition): Fragment => sql`LOWER(${column})`

/** Lowercased by the database, like `LOWER(column)`. */
const loweredList = (sql: SqlClient.SqlClient, values: Array.NonEmptyReadonlyArray<unknown>): Fragment =>
  // `sql.join` parenthesizes only 2+ items, and `IN LOWER(?)` parses as a table.
  sql`(${sql.join(', ', false)(Array.map(values, (value) => sql`LOWER(${value})`))})`

/** MySQL's default collations ignore case. The collation goes on the value: it is utf8mb4, the column may not be. */
const binary = (sql: SqlClient.SqlClient, value: unknown): Fragment => sql`(${value} COLLATE utf8mb4_bin)`

const binaryList = (sql: SqlClient.SqlClient, values: Array.NonEmptyReadonlyArray<unknown>): Fragment =>
  sql`(${sql.join(', ', false)(Array.map(values, (value) => binary(sql, value)))})`

interface Exact {
  readonly eq: (condition: Condition) => Fragment
  readonly ne: (condition: Condition) => Fragment
  readonly in: (condition: Condition, values: Array.NonEmptyReadonlyArray<unknown>) => Fragment
  readonly not_in: (condition: Condition, values: Array.NonEmptyReadonlyArray<unknown>) => Fragment
}

/** SQLite and PostgreSQL compare strings exactly by default. */
const plainExact: Exact = {
  eq: (condition) => condition.sql`${condition.column} = ${scalar(condition)}`,
  ne: (condition) => condition.sql`${condition.column} <> ${scalar(condition)}`,
  in: (condition, values) => condition.sql`${condition.column} IN ${condition.sql.in(values)}`,
  not_in: (condition, values) => condition.sql`${condition.column} NOT IN ${condition.sql.in(values)}`,
}

const allStrings = (values: ReadonlyArray<unknown>): boolean => Array.every(values, Predicate.isString)

/** The plain `=`/`IN` keeps an exact index lookup; the binary comparison decides. */
const mysqlExact: Exact = {
  eq: (condition) =>
    Predicate.isString(condition.value)
      ? condition.sql`(${condition.column} = ${condition.value} AND ${condition.column} = ${binary(condition.sql, condition.value)})`
      : plainExact.eq(condition),
  ne: (condition) =>
    Predicate.isString(condition.value)
      ? condition.sql`${condition.column} <> ${binary(condition.sql, condition.value)}`
      : plainExact.ne(condition),
  in: (condition, values) =>
    allStrings(values)
      ? condition.sql`(${condition.column} IN ${condition.sql.in(values)} AND ${condition.column} IN ${binaryList(condition.sql, values)})`
      : plainExact.in(condition, values),
  not_in: (condition, values) =>
    allStrings(values)
      ? condition.sql`${condition.column} NOT IN ${binaryList(condition.sql, values)}`
      : plainExact.not_in(condition, values),
}

const exact: Record<Dialect, Exact> = { sqlite: plainExact, pg: plainExact, mysql: mysqlExact }

interface Wildcards {
  readonly before: boolean
  readonly after: boolean
}

const textOf = (value: unknown): string => `${value}`

const LIKE_ESCAPE = '!'

const likePattern = (value: string, { before, after }: Wildcards): string =>
  `${before ? '%' : ''}${String.replace(/[!%_]/g, `${LIKE_ESCAPE}$&`)(value)}${after ? '%' : ''}`

/** GLOB has no ESCAPE clause: `[*]` matches `*` literally. */
const globPattern = (value: string, { before, after }: Wildcards): string =>
  `${before ? '*' : ''}${String.replace(/[[*?]/g, '[$&]')(value)}${after ? '*' : ''}`

const escapeClause = (sql: SqlClient.SqlClient): Fragment => sql.literal(`ESCAPE '${LIKE_ESCAPE}'`)

const sensitiveMatch: Record<Dialect, (condition: Condition, wildcards: Wildcards) => Fragment> = {
  // SQLite's LIKE ignores ASCII case; GLOB is case-sensitive.
  sqlite: ({ sql, column, value }, wildcards) => sql`${column} GLOB ${globPattern(textOf(value), wildcards)}`,
  pg: ({ sql, column, value }, wildcards) =>
    sql`${column} LIKE ${likePattern(textOf(value), wildcards)} ${escapeClause(sql)}`,
  mysql: ({ sql, column, value }, wildcards) =>
    sql`${column} LIKE ${binary(sql, likePattern(textOf(value), wildcards))} ${escapeClause(sql)}`,
}

const loweredLike = (condition: Condition, wildcards: Wildcards): Fragment =>
  condition.sql`${lowered(condition)} LIKE LOWER(${likePattern(textOf(condition.value), wildcards)}) ${escapeClause(condition.sql)}`

const insensitiveMatch: Record<Dialect, (condition: Condition, wildcards: Wildcards) => Fragment> = {
  sqlite: loweredLike,
  pg: ({ sql, column, value }, wildcards) =>
    sql`${column} ILIKE ${likePattern(textOf(value), wildcards)} ${escapeClause(sql)}`,
  mysql: loweredLike,
}

const patternMatch =
  (wildcards: Wildcards) =>
  (condition: Condition): Fragment =>
    (condition.insensitive ? insensitiveMatch : sensitiveMatch)[condition.dialect](condition, wildcards)

const compare =
  (operator: '<' | '<=' | '>' | '>=') =>
  (condition: Condition): Fragment =>
    condition.sql`${condition.column} ${condition.sql.literal(operator)} ${scalar(condition)}`

const equality =
  (nullCheck: 'IS NULL' | 'IS NOT NULL', operator: '=' | '<>', exactly: (condition: Condition) => Fragment) =>
  (condition: Condition): Fragment =>
    Match.value(condition).pipe(
      Match.when({ value: Predicate.isNull }, ({ sql, column }): Fragment => sql`${column} ${sql.literal(nullCheck)}`),
      Match.when(
        { insensitive: true },
        (): Fragment =>
          condition.sql`${lowered(condition)} ${condition.sql.literal(operator)} LOWER(${condition.value})`,
      ),
      Match.orElse(exactly),
    )

interface InList {
  readonly empty: '1 = 0' | '1 = 1'
  readonly nullCheck: 'IS NULL' | 'IS NOT NULL'
  readonly connector: 'OR' | 'AND'
  readonly values: (condition: Condition, values: Array.NonEmptyReadonlyArray<unknown>) => Fragment
}

/** `IN` never matches NULL, and a NULL inside `NOT IN` makes it match nothing: nulls get their own clause. */
const inList =
  ({ empty, nullCheck, connector, values }: InList) =>
  (condition: Condition): Fragment => {
    const { sql, column } = condition
    const all = list(condition)
    const nulls = Option.liftPredicate(sql`${column} ${sql.literal(nullCheck)}`, () =>
      Array.some(all, Predicate.isNull),
    )
    return Array.match(Array.filter(all, Predicate.isNotNull), {
      onEmpty: () => Option.getOrElse(nulls, () => sql.literal(empty)),
      onNonEmpty: (present) =>
        Option.match(nulls, {
          onNone: () => values(condition, present),
          onSome: (isNull) => sql`(${values(condition, present)} ${sql.literal(connector)} ${isNull})`,
        }),
    })
  }

const operators: Record<WhereOperator, (condition: Condition) => Fragment> = {
  eq: equality('IS NULL', '=', (condition) => exact[condition.dialect].eq(condition)),
  ne: equality('IS NOT NULL', '<>', (condition) => exact[condition.dialect].ne(condition)),
  lt: compare('<'),
  lte: compare('<='),
  gt: compare('>'),
  gte: compare('>='),
  in: inList({
    empty: '1 = 0',
    nullCheck: 'IS NULL',
    connector: 'OR',
    values: (condition, values) =>
      condition.insensitive
        ? condition.sql`${lowered(condition)} IN ${loweredList(condition.sql, values)}`
        : exact[condition.dialect].in(condition, values),
  }),
  not_in: inList({
    empty: '1 = 1',
    nullCheck: 'IS NOT NULL',
    connector: 'AND',
    values: (condition, values) =>
      condition.insensitive
        ? condition.sql`${lowered(condition)} NOT IN ${loweredList(condition.sql, values)}`
        : exact[condition.dialect].not_in(condition, values),
  }),
  contains: patternMatch({ before: true, after: true }),
  starts_with: patternMatch({ before: false, after: true }),
  ends_with: patternMatch({ before: true, after: false }),
}

/** `LOWER()` applies to strings only. */
const isInsensitive = ({ mode, value }: CleanedWhere): boolean =>
  mode === 'insensitive' &&
  (Predicate.isString(value) ||
    (Array.isArray(value) && Array.every(value as ReadonlyArray<unknown>, Predicate.isString)))

const toFragment =
  (sql: SqlClient.SqlClient, dialect: Dialect) =>
  (where: CleanedWhere): Fragment =>
    operators[where.operator ?? 'eq']({
      sql,
      dialect,
      column: sql`${sql(where.field)}`,
      value: where.value,
      insensitive: isInsensitive(where),
    })

/** Grouped as `(AND …) AND (OR …)`, like better-auth's own adapters. */
export const whereCondition = (
  sql: SqlClient.SqlClient,
  dialect: Dialect,
  where: ReadonlyArray<CleanedWhere>,
): Option.Option<Fragment> => {
  const group = (connector: 'AND' | 'OR', combine: (clauses: ReadonlyArray<Fragment>) => Fragment) =>
    pipe(
      Array.filter(where, (condition) => (condition.connector === 'OR' ? 'OR' : 'AND') === connector),
      Array.map(toFragment(sql, dialect)),
      Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
      Option.map(combine),
    )
  return pipe(
    Array.getSomes([group('AND', (clauses) => sql.and(clauses)), group('OR', (clauses) => sql.or(clauses))]),
    Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
    Option.map((groups) => sql.and(groups)),
  )
}
