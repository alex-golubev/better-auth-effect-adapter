import type { JoinConfig } from 'better-auth/adapters'
import { Array as Arr, Effect, Option, Predicate, pipe } from 'effect'
import type { SqlClient, SqlError } from 'effect/sql'
import type { Row } from './operations'

type Join = JoinConfig[string]

/** better-auth's default join limit. */
const DEFAULT_JOIN_LIMIT = 100

interface Joined {
  readonly table: string
  readonly join: Join
  readonly byKey: Record<string, Arr.NonEmptyArray<Row>>
}

/** Keys may differ in JS type, e.g. `1` and `1n`. */
const keyOf = (value: unknown): string => String(value)

const fetchJoined = (
  sql: SqlClient.SqlClient,
  table: string,
  join: Join,
  parents: ReadonlyArray<Row>,
): Effect.Effect<Joined, SqlError.SqlError> =>
  pipe(
    Arr.map(parents, (parent) => parent[join.on.from]),
    Arr.filter(Predicate.isNotNullish),
    Arr.dedupeWith((a, b) => keyOf(a) === keyOf(b)),
    Arr.match({
      onEmpty: () => Effect.succeed<ReadonlyArray<Row>>([]),
      onNonEmpty: (keys) => sql<Row>`SELECT * FROM ${sql(table)} WHERE ${sql.in(join.on.to, keys)}`,
    }),
    Effect.map((rows) => ({ table, join, byKey: Arr.groupBy(rows, (row) => keyOf(row[join.on.to])) })),
  )

const related = ({ join, byKey }: Joined, parent: Row): Row | ReadonlyArray<Row> | null => {
  const matches = Option.fromUndefinedOr(byKey[keyOf(parent[join.on.from])])
  return join.relation === 'one-to-one'
    ? pipe(matches, Option.map(Arr.headNonEmpty), Option.getOrNull)
    : pipe(
        matches,
        Option.map(Arr.take(join.limit ?? DEFAULT_JOIN_LIMIT)),
        Option.getOrElse((): ReadonlyArray<Row> => []),
      )
}

/** One `IN` query per joined table, not per row. Sequential, so a join takes no extra pool connections. */
export const attachJoins = (
  sql: SqlClient.SqlClient,
  join: JoinConfig,
  parents: ReadonlyArray<Row>,
): Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError> =>
  Effect.map(
    Effect.forEach(Object.entries(join), ([table, entry]) => fetchJoined(sql, table, entry, parents)),
    (joined) =>
      Arr.map(parents, (parent) =>
        Arr.reduce(joined, parent, (row, entry) => ({ ...row, [entry.table]: related(entry, parent) })),
      ),
  )
