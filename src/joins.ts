import type { JoinConfig } from 'better-auth/adapters'
import { Array, Effect, Option, Predicate, pipe, Record } from 'effect'
import type { SqlClient, SqlError } from 'effect/sql'
import type { Row } from './operations'

type Join = JoinConfig[string]

interface Joined {
  readonly table: string
  readonly join: Join
  readonly byKey: Record<string, Array.NonEmptyArray<Row>>
}

/** Keys may differ in JS type, e.g. `1` and `1n`. */
const keyOf = (value: unknown): string => String(value)

/** Lowercase without underscores: the client's name transforms leave it as is, so it can be dropped. */
const RANK = 'joinrank'

/** The limit applies per parent, in SQL: a parent with many children doesn't load them all. */
const joinedRows = (
  sql: SqlClient.SqlClient,
  table: string,
  join: Join,
  keys: Array.NonEmptyReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError> =>
  Option.match(Option.fromUndefinedOr(join.limit), {
    onNone: () => sql<Row>`SELECT * FROM ${sql(table)} WHERE ${sql.in(join.on.to, keys)}`,
    onSome: (limit) =>
      Effect.map(
        sql<Row>`SELECT * FROM (
          SELECT ${sql(table)}.*, ROW_NUMBER() OVER (PARTITION BY ${sql(join.on.to)}) AS ${sql(RANK)}
          FROM ${sql(table)} WHERE ${sql.in(join.on.to, keys)}
        ) ${sql('ranked')} WHERE ${sql(RANK)} <= ${limit}`,
        Array.map((row) => Record.remove(row, RANK)),
      ),
  })

const fetchJoined = (
  sql: SqlClient.SqlClient,
  table: string,
  join: Join,
  parents: ReadonlyArray<Row>,
): Effect.Effect<Joined, SqlError.SqlError> =>
  pipe(
    Array.map(parents, (parent) => parent[join.on.from]),
    Array.filter(Predicate.isNotNullish),
    (keys) => Record.values(Record.fromEntries(Array.map(keys, (key) => [keyOf(key), key] as const))),
    Array.match({
      onEmpty: () => Effect.succeed<ReadonlyArray<Row>>([]),
      onNonEmpty: (keys) => joinedRows(sql, table, join, keys),
    }),
    Effect.map((rows) => ({ table, join, byKey: Array.groupBy(rows, (row) => keyOf(row[join.on.to])) })),
  )

const related = ({ join, byKey }: Joined, parent: Row): Row | ReadonlyArray<Row> | null => {
  const matches = Option.fromUndefinedOr(byKey[keyOf(parent[join.on.from])])
  return join.relation === 'one-to-one'
    ? pipe(matches, Option.map(Array.headNonEmpty), Option.getOrNull)
    : Option.getOrElse(matches, (): ReadonlyArray<Row> => [])
}

/** One `IN` query per joined table, not per row. Sequential, so a join takes no extra pool connections. */
export const attachJoins = (
  sql: SqlClient.SqlClient,
  join: JoinConfig,
  parents: ReadonlyArray<Row>,
): Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError> =>
  Effect.map(
    Effect.forEach(Record.toEntries(join), ([table, entry]) => fetchJoined(sql, table, entry, parents)),
    (joined) =>
      Array.map(parents, (parent) =>
        Array.reduce(joined, parent, (row, entry) => ({ ...row, [entry.table]: related(entry, parent) })),
      ),
  )
