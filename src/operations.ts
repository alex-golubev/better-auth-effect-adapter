import { Array as Arr, Effect, Option, Predicate, pipe } from 'effect'
import type { SqlClient, SqlError, Statement } from 'effect/sql'
import type { Dialect } from './dialect'
import { EffectSqlAdapterError } from './errors'

/** A row keyed by physical column names, as better-auth's factory expects it back. */
export type Row = Record<string, unknown>

type Fragment = Statement.Fragment
type Operation<A> = Effect.Effect<A, SqlError.SqlError | EffectSqlAdapterError>

export interface Sort {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export interface Read {
  readonly table: string
  /** Physical column names; empty selects every column. */
  readonly columns: ReadonlyArray<string>
  readonly where: Option.Option<Fragment>
}

export interface Page {
  readonly sort: Option.Option<Sort>
  readonly limit: number
  readonly offset: Option.Option<number>
}

const adapterError = (message: string) => new EffectSqlAdapterError({ message })

// ---------------------------------------------------------------------------
// Fragments

const empty = (sql: SqlClient.SqlClient): Fragment => sql.literal('')

const whereSql = (sql: SqlClient.SqlClient, where: Option.Option<Fragment>): Fragment =>
  Option.match(where, { onNone: () => empty(sql), onSome: (condition) => sql`WHERE ${condition}` })

const columnsSql = (sql: SqlClient.SqlClient, columns: ReadonlyArray<string>): Fragment =>
  Arr.match(columns, {
    onEmpty: () => sql.literal('*'),
    onNonEmpty: (names) => sql.join(', ', false)(Arr.map(names, (name) => sql`${sql(name)}`)),
  })

const orderBySql = (sql: SqlClient.SqlClient, sort: Option.Option<Sort>): Fragment =>
  Option.match(sort, {
    onNone: () => empty(sql),
    onSome: ({ column, direction }) =>
      sql`ORDER BY ${sql(column)} ${sql.literal(direction === 'desc' ? 'DESC' : 'ASC')}`,
  })

const nonNegativeInteger = (name: string, value: number): Effect.Effect<number, EffectSqlAdapterError> =>
  Effect.succeed(value).pipe(
    Effect.filterOrFail(
      (n) => Number.isSafeInteger(n) && n >= 0,
      () => adapterError(`${name} must be a non-negative integer, got ${value}`),
    ),
  )

/** Inlined as literals (validated integers): mysql2 can't bind LIMIT/OFFSET parameters. */
const pageSql = (
  sql: SqlClient.SqlClient,
  { sort, limit, offset }: Page,
): Effect.Effect<Fragment, EffectSqlAdapterError> =>
  Effect.gen(function* () {
    const rows = yield* nonNegativeInteger('limit', limit)
    const skip = yield* Option.match(offset, {
      onNone: () => Effect.succeed(empty(sql)),
      onSome: (n) => Effect.map(nonNegativeInteger('offset', n), (valid) => sql`OFFSET ${sql.literal(String(valid))}`),
    })
    return sql`${orderBySql(sql, sort)} LIMIT ${sql.literal(String(rows))} ${skip}`
  })

// ---------------------------------------------------------------------------
// Raw execution and affected rows

/** `.raw` skips `transformQueryNames`; compiling first keeps identifier transforms. */
const executeRaw = (sql: SqlClient.SqlClient, statement: Statement.Statement<Row>) =>
  Effect.flatMap(
    Effect.sync(() => statement.compile()),
    ([query, params]) => sql.unsafe(query, params).raw,
  )

const affectedRowsKeys: Record<Dialect, string> = { sqlite: 'changes', pg: 'rowCount', mysql: 'affectedRows' }

const affectedRows =
  (dialect: Dialect) =>
  (raw: unknown): Effect.Effect<number, EffectSqlAdapterError> =>
    pipe(
      Option.liftPredicate(raw, Predicate.hasProperty(affectedRowsKeys[dialect])),
      Option.map((result) => result[affectedRowsKeys[dialect]]),
      Option.filter((count) => Predicate.isNumber(count) || Predicate.isBigInt(count)),
      Option.map(Number),
      Effect.fromOption,
      Effect.mapError(() => adapterError(`The ${dialect} driver did not report affected rows`)),
    )

// ---------------------------------------------------------------------------
// RETURNING strategies

interface Returning {
  readonly insert: (sql: SqlClient.SqlClient, table: string, data: Row) => Operation<Row>
  readonly update: (
    sql: SqlClient.SqlClient,
    table: string,
    where: Option.Option<Fragment>,
    data: Row,
  ) => Operation<Row | null>
  /** Deletes at most one matching row and returns it. */
  readonly consume: (sql: SqlClient.SqlClient, table: string, where: Option.Option<Fragment>) => Operation<Row | null>
  /** Applies `assignments` to at most one matching row and returns it. */
  readonly modifyOne: (
    sql: SqlClient.SqlClient,
    table: string,
    where: Option.Option<Fragment>,
    assignments: Fragment,
  ) => Operation<Row | null>
}

/** `id IN (first matching id)`: a single statement touches at most one row, atomically. */
const firstMatch = (sql: SqlClient.SqlClient, table: string, where: Option.Option<Fragment>): Fragment =>
  sql`${sql('id')} IN (SELECT ${sql('id')} FROM ${sql(table)} ${whereSql(sql, where)} LIMIT 1)`

const firstRow = (rows: ReadonlyArray<Row>, message: string): Effect.Effect<Row, EffectSqlAdapterError> =>
  Effect.mapError(Effect.fromOption(Arr.head(rows)), () => adapterError(message))

const nativeReturning: Returning = {
  insert: (sql, table, data) =>
    Effect.flatMap(sql<Row>`INSERT INTO ${sql(table)} ${sql.insert(data).returning('*')}`, (rows) =>
      firstRow(rows, `INSERT into "${table}" returned no row`),
    ),
  update: (sql, table, where, data) =>
    Effect.map(sql<Row>`UPDATE ${sql(table)} SET ${sql.update(data)} ${whereSql(sql, where)} RETURNING *`, (rows) =>
      Option.getOrNull(Arr.head(rows)),
    ),
  consume: (sql, table, where) =>
    Effect.map(sql<Row>`DELETE FROM ${sql(table)} WHERE ${firstMatch(sql, table, where)} RETURNING *`, (rows) =>
      Option.getOrNull(Arr.head(rows)),
    ),
  modifyOne: (sql, table, where, assignments) =>
    Effect.map(
      sql<Row>`UPDATE ${sql(table)} SET ${assignments} WHERE ${firstMatch(sql, table, where)} RETURNING *`,
      (rows) => Option.getOrNull(Arr.head(rows)),
    ),
}

const unsupported = (feature: string): Operation<never> => Effect.fail(adapterError(`${feature} is not supported yet`))

const returning: Record<Dialect, Returning> = {
  sqlite: nativeReturning,
  pg: nativeReturning,
  mysql: {
    insert: () => unsupported('INSERT on MySQL'),
    update: () => unsupported('UPDATE on MySQL'),
    consume: () => unsupported('consumeOne on MySQL'),
    modifyOne: () => unsupported('incrementOne on MySQL'),
  },
}

// ---------------------------------------------------------------------------
// Operations

export const create = (sql: SqlClient.SqlClient, dialect: Dialect, table: string, data: Row): Operation<Row> =>
  returning[dialect].insert(sql, table, data)

export const findOne = (sql: SqlClient.SqlClient, { table, columns, where }: Read): Operation<Row | null> =>
  Effect.map(sql<Row>`SELECT ${columnsSql(sql, columns)} FROM ${sql(table)} ${whereSql(sql, where)} LIMIT 1`, (rows) =>
    Option.getOrNull(Arr.head(rows)),
  )

export const findMany = (
  sql: SqlClient.SqlClient,
  { table, columns, where }: Read,
  page: Page,
): Operation<ReadonlyArray<Row>> =>
  Effect.flatMap(
    pageSql(sql, page),
    (paging) => sql<Row>`SELECT ${columnsSql(sql, columns)} FROM ${sql(table)} ${whereSql(sql, where)} ${paging}`,
  )

export const update = (
  sql: SqlClient.SqlClient,
  dialect: Dialect,
  table: string,
  where: Option.Option<Fragment>,
  data: Row,
): Operation<Row | null> => returning[dialect].update(sql, table, where, data)

export const updateMany = (
  sql: SqlClient.SqlClient,
  dialect: Dialect,
  table: string,
  where: Option.Option<Fragment>,
  data: Row,
): Operation<number> =>
  Effect.flatMap(
    executeRaw(sql, sql<Row>`UPDATE ${sql(table)} SET ${sql.update(data)} ${whereSql(sql, where)}`),
    affectedRows(dialect),
  )

export const remove = (sql: SqlClient.SqlClient, table: string, where: Option.Option<Fragment>): Operation<void> =>
  Effect.asVoid(sql`DELETE FROM ${sql(table)} ${whereSql(sql, where)}`)

export const removeMany = (
  sql: SqlClient.SqlClient,
  dialect: Dialect,
  table: string,
  where: Option.Option<Fragment>,
): Operation<number> =>
  Effect.flatMap(executeRaw(sql, sql<Row>`DELETE FROM ${sql(table)} ${whereSql(sql, where)}`), affectedRows(dialect))

export const count = (sql: SqlClient.SqlClient, table: string, where: Option.Option<Fragment>): Operation<number> =>
  Effect.map(
    sql<{ total: unknown }>`SELECT COUNT(*) AS ${sql('total')} FROM ${sql(table)} ${whereSql(sql, where)}`,
    (rows) =>
      pipe(
        Arr.head(rows),
        Option.map((row) => Number(row.total)),
        Option.getOrElse(() => 0),
      ),
  )

export const consumeOne = (
  sql: SqlClient.SqlClient,
  dialect: Dialect,
  table: string,
  where: Option.Option<Fragment>,
): Operation<Row | null> => returning[dialect].consume(sql, table, where)

/** `col = col + n` for each increment, `col = value` for each `set` entry. */
const assignments = (sql: SqlClient.SqlClient, increment: Record<string, number>, set: Row): Fragment =>
  sql.join(
    ', ',
    false,
  )([
    ...Arr.map(Object.entries(increment), ([column, by]) => sql`${sql(column)} = ${sql(column)} + ${by}`),
    ...Arr.map(Object.entries(set), ([column, value]) => sql`${sql(column)} = ${value}`),
  ])

export const incrementOne = (
  sql: SqlClient.SqlClient,
  dialect: Dialect,
  table: string,
  where: Option.Option<Fragment>,
  increment: Record<string, number>,
  set: Row,
): Operation<Row | null> => returning[dialect].modifyOne(sql, table, where, assignments(sql, increment, set))
