import type { CleanedWhere, WhereOperator } from 'better-auth/adapters'
import { Array as Arr, Match, Option, Predicate, pipe } from 'effect'
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
      Match.when(Predicate.isBoolean, (bool) => (profile.supportsBooleans ? bool : bool ? 1 : 0)),
      Match.orElse((other) => other),
    )

const scalar = (condition: Condition): unknown => toSqlValue(dialectProfiles[condition.dialect])(condition.value)

const list = (condition: Condition): ReadonlyArray<unknown> =>
  Arr.map(
    Arr.isArray(condition.value) ? condition.value : [condition.value],
    toSqlValue(dialectProfiles[condition.dialect]),
  )

const lowered = ({ sql, column }: Condition): Fragment => sql`LOWER(${column})`

/** Lowercased by the database, like `LOWER(column)`. */
const loweredList = (sql: SqlClient.SqlClient, values: Arr.NonEmptyReadonlyArray<unknown>): Fragment =>
  // `sql.join` parenthesizes only 2+ items, and `IN LOWER(?)` parses as a table.
  sql`(${sql.join(', ', false)(Arr.map(values, (value) => sql`LOWER(${value})`))})`

/** MySQL's default collations ignore case. The collation goes on the value: it is utf8mb4, the column may not be. */
const binary = (sql: SqlClient.SqlClient, value: unknown): Fragment => sql`(${value} COLLATE utf8mb4_bin)`

const binaryList = (sql: SqlClient.SqlClient, values: Arr.NonEmptyReadonlyArray<unknown>): Fragment =>
  sql`(${sql.join(', ', false)(Arr.map(values, (value) => binary(sql, value)))})`

interface Exact {
  readonly eq: (condition: Condition) => Fragment
  readonly ne: (condition: Condition) => Fragment
  readonly in: (condition: Condition, values: Arr.NonEmptyReadonlyArray<unknown>) => Fragment
  readonly not_in: (condition: Condition, values: Arr.NonEmptyReadonlyArray<unknown>) => Fragment
}

/** SQLite and PostgreSQL compare strings exactly by default. */
const plainExact: Exact = {
  eq: (condition) => condition.sql`${condition.column} = ${scalar(condition)}`,
  ne: (condition) => condition.sql`${condition.column} <> ${scalar(condition)}`,
  in: (condition, values) => condition.sql`${condition.column} IN ${condition.sql.in(values)}`,
  not_in: (condition, values) => condition.sql`${condition.column} NOT IN ${condition.sql.in(values)}`,
}

const allStrings = (values: ReadonlyArray<unknown>): boolean => Arr.every(values, Predicate.isString)

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

const LIKE_ESCAPE = '!'

const likePattern = (value: string, { before, after }: Wildcards): string =>
  `${before ? '%' : ''}${value.replace(/[!%_]/g, `${LIKE_ESCAPE}$&`)}${after ? '%' : ''}`

/** GLOB has no ESCAPE clause: `[*]` matches `*` literally. */
const globPattern = (value: string, { before, after }: Wildcards): string =>
  `${before ? '*' : ''}${value.replace(/[[*?]/g, '[$&]')}${after ? '*' : ''}`

const escapeClause = (sql: SqlClient.SqlClient): Fragment => sql.literal(`ESCAPE '${LIKE_ESCAPE}'`)

const sensitiveMatch: Record<Dialect, (condition: Condition, wildcards: Wildcards) => Fragment> = {
  // SQLite's LIKE ignores ASCII case; GLOB is case-sensitive.
  sqlite: ({ sql, column, value }, wildcards) => sql`${column} GLOB ${globPattern(String(value), wildcards)}`,
  pg: ({ sql, column, value }, wildcards) =>
    sql`${column} LIKE ${likePattern(String(value), wildcards)} ${escapeClause(sql)}`,
  mysql: ({ sql, column, value }, wildcards) =>
    sql`${column} LIKE ${binary(sql, likePattern(String(value), wildcards))} ${escapeClause(sql)}`,
}

const insensitiveMatch: Record<Dialect, (condition: Condition, wildcards: Wildcards) => Fragment> = {
  sqlite: (condition, wildcards) =>
    condition.sql`${lowered(condition)} LIKE LOWER(${likePattern(String(condition.value), wildcards)}) ${escapeClause(condition.sql)}`,
  pg: ({ sql, column, value }, wildcards) =>
    sql`${column} ILIKE ${likePattern(String(value), wildcards)} ${escapeClause(sql)}`,
  mysql: (condition, wildcards) =>
    condition.sql`${lowered(condition)} LIKE LOWER(${likePattern(String(condition.value), wildcards)}) ${escapeClause(condition.sql)}`,
}

const patternMatch =
  (wildcards: Wildcards) =>
  (condition: Condition): Fragment =>
    (condition.insensitive ? insensitiveMatch : sensitiveMatch)[condition.dialect](condition, wildcards)

const compare =
  (operator: '<' | '<=' | '>' | '>=') =>
  (condition: Condition): Fragment =>
    condition.sql`${condition.column} ${condition.sql.literal(operator)} ${scalar(condition)}`

const operators: Record<WhereOperator, (condition: Condition) => Fragment> = {
  eq: (condition) =>
    condition.value === null
      ? condition.sql`${condition.column} IS NULL`
      : condition.insensitive
        ? condition.sql`${lowered(condition)} = LOWER(${condition.value})`
        : exact[condition.dialect].eq(condition),
  ne: (condition) =>
    condition.value === null
      ? condition.sql`${condition.column} IS NOT NULL`
      : condition.insensitive
        ? condition.sql`${lowered(condition)} <> LOWER(${condition.value})`
        : exact[condition.dialect].ne(condition),
  lt: compare('<'),
  lte: compare('<='),
  gt: compare('>'),
  gte: compare('>='),
  in: (condition) =>
    Arr.match(list(condition), {
      onEmpty: () => condition.sql`1 = 0`,
      onNonEmpty: (values) =>
        condition.insensitive
          ? condition.sql`${lowered(condition)} IN ${loweredList(condition.sql, values)}`
          : exact[condition.dialect].in(condition, values),
    }),
  not_in: (condition) =>
    Arr.match(list(condition), {
      onEmpty: () => condition.sql`1 = 1`,
      onNonEmpty: (values) =>
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
  (Predicate.isString(value) || (Arr.isArray(value) && Arr.every(value as ReadonlyArray<unknown>, Predicate.isString)))

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
      Arr.filter(where, (condition) => (condition.connector === 'OR' ? 'OR' : 'AND') === connector),
      Arr.map(toFragment(sql, dialect)),
      Option.liftPredicate(Arr.isReadonlyArrayNonEmpty),
      Option.map(combine),
    )
  return pipe(
    Arr.getSomes([group('AND', (clauses) => sql.and(clauses)), group('OR', (clauses) => sql.or(clauses))]),
    Option.liftPredicate(Arr.isReadonlyArrayNonEmpty),
    Option.map((groups) => sql.and(groups)),
  )
}
