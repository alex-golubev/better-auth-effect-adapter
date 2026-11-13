import { Array as Arr, Effect, Option, Predicate, pipe } from 'effect'
import type { SqlClient, SqlError, Statement } from 'effect/sql'
import type { Dialect } from './dialect'
import { adapterError, type EffectSqlAdapterError } from './errors'

/** Keyed by physical column names, as the factory expects. */
export type Row = Record<string, unknown>

type Fragment = Statement.Fragment
type Operation<A> = Effect.Effect<A, SqlError.SqlError | EffectSqlAdapterError>

export interface Sort {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export interface Read {
  readonly table: string
  /** Physical names; empty selects all. */
  readonly columns: ReadonlyArray<string>
  readonly where: Option.Option<Fragment>
}

export interface Page {
  readonly sort: Option.Option<Sort>
  readonly limit: number
  readonly offset: Option.Option<number>
}

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

/** Validated literals: mysql2 can't bind LIMIT/OFFSET. */
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

/** `.raw` skips `transformQueryNames`, so compile first. */
const executeRaw = (sql: SqlClient.SqlClient, statement: Statement.Statement<Row>) =>
  Effect.flatMap(
    Effect.sync(() => statement.compile()),
    ([query, params]) => sql.unsafe(query, params).raw,
  )

/** Drivers of one dialect report it under different keys (node:sqlite `changes`, libsql `rowsAffected`, …). */
const affectedRowsKeys = ['changes', 'rowCount', 'affectedRows', 'rowsAffected'] as const

export const affectedRows = (raw: unknown): Effect.Effect<number, EffectSqlAdapterError> =>
  pipe(
    Arr.findFirst(affectedRowsKeys, (key) =>
      pipe(
        Option.liftPredicate(raw, Predicate.hasProperty(key)),
        Option.map((result) => result[key]),
        Option.filter((count) => Predicate.isNumber(count) || Predicate.isBigInt(count)),
      ),
    ),
    Option.map(Number),
    Effect.fromOption,
    Effect.mapError(() => adapterError('The driver did not report affected rows')),
  )

export const firstOrNull = (rows: ReadonlyArray<Row>): Row | null => Option.getOrNull(Arr.head(rows))

const firstRow = (rows: ReadonlyArray<Row>, message: string): Effect.Effect<Row, EffectSqlAdapterError> =>
  Effect.mapError(Effect.fromOption(Arr.head(rows)), () => adapterError(message))

interface Returning {
  readonly insert: (sql: SqlClient.SqlClient, table: string, data: Row) => Operation<Row>
  readonly update: (
    sql: SqlClient.SqlClient,
    table: string,
    where: Option.Option<Fragment>,
    data: Row,
  ) => Operation<Row | null>
  /** Deletes at most one matching row. */
  readonly consume: (sql: SqlClient.SqlClient, table: string, where: Option.Option<Fragment>) => Operation<Row | null>
  readonly modifyOne: (
    sql: SqlClient.SqlClient,
    table: string,
    where: Option.Option<Fragment>,
    assignments: Fragment,
  ) => Operation<Row | null>
}

/**
 * At most one row, atomically, in a single statement. PostgreSQL re-checks only the outer
 * condition on a row a concurrent write changed, not the subquery, hence the condition twice.
 */
const firstMatch = (sql: SqlClient.SqlClient, table: string, where: Option.Option<Fragment>): Fragment => {
  const first = sql`${sql('id')} IN (SELECT ${sql('id')} FROM ${sql(table)} ${whereSql(sql, where)} LIMIT 1)`
  return Option.match(where, { onNone: () => first, onSome: (condition) => sql`${first} AND (${condition})` })
}

const nativeReturning: Returning = {
  insert: (sql, table, data) =>
    Effect.flatMap(sql<Row>`INSERT INTO ${sql(table)} ${sql.insert(data).returning('*')}`, (rows) =>
      firstRow(rows, `INSERT into "${table}" returned no row`),
    ),
  update: (sql, table, where, data) =>
    Effect.map(sql<Row>`UPDATE ${sql(table)} SET ${sql.update(data)} ${whereSql(sql, where)} RETURNING *`, firstOrNull),
  consume: (sql, table, where) =>
    Effect.map(sql<Row>`DELETE FROM ${sql(table)} WHERE ${firstMatch(sql, table, where)} RETURNING *`, firstOrNull),
  modifyOne: (sql, table, where, assignments) =>
    Effect.map(
      sql<Row>`UPDATE ${sql(table)} SET ${assignments} WHERE ${firstMatch(sql, table, where)} RETURNING *`,
      firstOrNull,
    ),
}

const selectById = (sql: SqlClient.SqlClient, table: string, id: unknown) =>
  sql<Row>`SELECT * FROM ${sql(table)} WHERE ${sql('id')} = ${id} LIMIT 1`

const lockMatching = (
  sql: SqlClient.SqlClient,
  table: string,
  where: Option.Option<Fragment>,
  { columns, limit }: { readonly columns: Fragment; readonly limit: Fragment },
) => sql<Row>`SELECT ${columns} FROM ${sql(table)} ${whereSql(sql, where)} ${limit} FOR UPDATE`

const insertedId = (data: Row, raw: unknown): Effect.Effect<unknown, EffectSqlAdapterError> =>
  pipe(
    Option.fromNullishOr(data.id),
    Option.orElse(() =>
      pipe(
        Option.liftPredicate(raw, Predicate.hasProperty('insertId')),
        Option.map((result) => result.insertId),
        // 0 means no auto-increment column; large ids arrive as strings.
        Option.filter(
          (id) => (Predicate.isNumber(id) || Predicate.isBigInt(id) || Predicate.isString(id)) && Number(id) > 0,
        ),
      ),
    ),
    Effect.fromOption,
    Effect.mapError(() => adapterError('The mysql driver did not report the id of the inserted row')),
  )

/**
 * No RETURNING: rows are read back by id. Rows picked by a condition are locked first (`FOR UPDATE`),
 * so a concurrent call can't take them. MySQL can't `LIMIT` an `IN` subquery, so no `firstMatch`.
 */
const mysqlReturning: Returning = {
  // Atomic on its own, with a known id: no transaction needed.
  insert: (sql, table, data) =>
    Effect.gen(function* () {
      const raw = yield* executeRaw(sql, sql<Row>`INSERT INTO ${sql(table)} ${sql.insert(data)}`)
      const id = yield* insertedId(data, raw)
      return yield* firstRow(yield* selectById(sql, table, id), `INSERT into "${table}" left no row to return`)
    }),
  update: (sql, table, where, data) =>
    sql.withTransaction(
      Effect.flatMap(lockMatching(sql, table, where, { columns: sql`${sql('id')}`, limit: empty(sql) }), (locked) =>
        Arr.match(locked, {
          onEmpty: () => Effect.succeed(null),
          onNonEmpty: (matched) =>
            Effect.andThen(
              sql`UPDATE ${sql(table)} SET ${sql.update(data)} WHERE ${sql.in(
                'id',
                Arr.map(matched, (row) => row.id),
              )}`,
              Effect.map(selectById(sql, table, data.id ?? Arr.headNonEmpty(matched).id), firstOrNull),
            ),
        }),
      ),
    ),
  consume: (sql, table, where) =>
    sql.withTransaction(
      Effect.flatMap(
        lockMatching(sql, table, where, { columns: sql.literal('*'), limit: sql.literal('LIMIT 1') }),
        (locked) =>
          Option.match(Arr.head(locked), {
            onNone: () => Effect.succeed(null),
            onSome: (row) => Effect.as(sql`DELETE FROM ${sql(table)} WHERE ${sql('id')} = ${row.id}`, row),
          }),
      ),
    ),
  modifyOne: (sql, table, where, assignments) =>
    sql.withTransaction(
      Effect.flatMap(
        lockMatching(sql, table, where, { columns: sql`${sql('id')}`, limit: sql.literal('LIMIT 1') }),
        (locked) =>
          Option.match(Arr.head(locked), {
            onNone: () => Effect.succeed(null),
            onSome: ({ id }) =>
              Effect.andThen(
                sql`UPDATE ${sql(table)} SET ${assignments} WHERE ${sql('id')} = ${id}`,
                Effect.map(selectById(sql, table, id), firstOrNull),
              ),
          }),
      ),
    ),
}

const returning: Record<Dialect, Returning> = {
  sqlite: nativeReturning,
  pg: nativeReturning,
  mysql: mysqlReturning,
}

export const create = (sql: SqlClient.SqlClient, dialect: Dialect, table: string, data: Row): Operation<Row> =>
  returning[dialect].insert(sql, table, data)

export const findOne = (sql: SqlClient.SqlClient, { table, columns, where }: Read): Operation<Row | null> =>
  Effect.map(
    sql<Row>`SELECT ${columnsSql(sql, columns)} FROM ${sql(table)} ${whereSql(sql, where)} LIMIT 1`,
    firstOrNull,
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
  table: string,
  where: Option.Option<Fragment>,
  data: Row,
): Operation<number> =>
  Effect.flatMap(
    executeRaw(sql, sql<Row>`UPDATE ${sql(table)} SET ${sql.update(data)} ${whereSql(sql, where)}`),
    affectedRows,
  )

/** Without a condition, deletes nothing: `delete` targets one record. `deleteMany` may clear a table. */
export const remove = (sql: SqlClient.SqlClient, table: string, where: Option.Option<Fragment>): Operation<void> =>
  Option.match(where, {
    onNone: () => Effect.void,
    onSome: (condition) => Effect.asVoid(sql`DELETE FROM ${sql(table)} WHERE ${condition}`),
  })

export const removeMany = (
  sql: SqlClient.SqlClient,
  table: string,
  where: Option.Option<Fragment>,
): Operation<number> =>
  Effect.flatMap(executeRaw(sql, sql<Row>`DELETE FROM ${sql(table)} ${whereSql(sql, where)}`), affectedRows)

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
