import { Effect, Option, pipe } from 'effect'
import type { SqlClient } from '@effect/sql'
import type { Primitive } from './types.js'

// ── Types ──

/**
 * Entry from Better Auth's JoinConfig.
 * Re-declared here for use in function signatures without importing the full JoinConfig.
 */
export interface JoinConfigEntry {
  readonly on: {
    readonly from: string
    readonly to: string
  }
  readonly limit?: number
  readonly relation?: 'one-to-one' | 'one-to-many' | 'many-to-many'
}

/**
 * Join configuration as passed by the Better Auth adapter factory.
 * Keys are database table names (already resolved by the factory).
 */
export type JoinConfig = {
  readonly [model: string]: JoinConfigEntry
}

// ── Constants ──

const DEFAULT_JOIN_LIMIT = 100

// ── Pure computations ──

/**
 * Collects distinct, non-null/undefined values for a given column from records.
 */
export const collectJoinValues = (records: ReadonlyArray<Record<string, unknown>>, columnName: string): Primitive[] => [
  ...new Set(records.map((r) => r[columnName]).filter((v): v is Primitive => v !== null && v !== undefined)),
]

/**
 * Builds a lookup index grouping joined rows by a key column value.
 * Follows the same reduce-with-accumulator pattern as groupByConnector in where-builder.ts.
 */
const buildJoinIndex = (
  rows: ReadonlyArray<Record<string, unknown>>,
  keyColumn: string,
): Map<unknown, Record<string, unknown>[]> =>
  rows.reduce<Map<unknown, Record<string, unknown>[]>>(
    (index, row) =>
      pipe(
        Option.fromNullable(row[keyColumn]),
        Option.match({
          onNone: () => index,
          onSome: (key) => {
            index.set(key, [...(index.get(key) ?? []), row])
            return index
          },
        }),
      ),
    new Map(),
  )

/**
 * Looks up matching rows from the join index for a given key value.
 */
const lookupMatches = (index: Map<unknown, Record<string, unknown>[]>, keyValue: unknown): Record<string, unknown>[] =>
  pipe(
    Option.fromNullable(keyValue),
    Option.flatMap((key) => Option.fromNullable(index.get(key))),
    Option.getOrElse((): Record<string, unknown>[] => []),
  )

/**
 * Resolves the attached value based on relation type and limit.
 */
const resolveAttachedValue = (
  matchingRows: Record<string, unknown>[],
  entry: JoinConfigEntry,
): Record<string, unknown> | Record<string, unknown>[] | null =>
  (entry.relation ?? 'one-to-many') === 'one-to-one'
    ? (matchingRows[0] ?? null)
    : matchingRows.slice(0, entry.limit ?? DEFAULT_JOIN_LIMIT)

/**
 * Attaches joined query results to main records based on the join configuration.
 * Returns a new array — does not mutate the input records.
 */
export const attachJoinResults = (
  mainRecords: ReadonlyArray<Record<string, unknown>>,
  joinedTableName: string,
  joinEntry: JoinConfigEntry,
  joinedRows: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown>[] => {
  const index = buildJoinIndex(joinedRows, joinEntry.on.to)

  return mainRecords.map((record) => ({
    ...record,
    [joinedTableName]: resolveAttachedValue(lookupMatches(index, record[joinEntry.on.from]), joinEntry),
  }))
}

// ── Effects ──

/**
 * Resolves a single join entry: fetches joined rows and attaches them to results.
 */
const resolveJoinEntry = (
  sql: SqlClient.SqlClient,
  mainRecords: ReadonlyArray<Record<string, unknown>>,
  currentResults: Record<string, unknown>[],
  joinedTable: string,
  joinEntry: JoinConfigEntry,
): Effect.Effect<Record<string, unknown>[], unknown> =>
  pipe(
    collectJoinValues(mainRecords, joinEntry.on.from),
    Option.liftPredicate((values) => values.length > 0),
    Option.match({
      onNone: () => Effect.succeed(attachJoinResults(currentResults, joinedTable, joinEntry, [])),
      onSome: (values) =>
        Effect.map(
          sql<Record<string, unknown>>`
            SELECT * FROM ${sql(joinedTable)}
            WHERE ${sql(joinEntry.on.to)} IN ${sql.in(values)}
          `,
          (joinedRows) => attachJoinResults(currentResults, joinedTable, joinEntry, joinedRows),
        ),
    }),
  )

/**
 * Resolves all joins by executing a separate SELECT query per joined model
 * and attaching the results to the main records.
 *
 * Uses Effect.reduce to sequentially fold over join entries,
 * accumulating enriched results after each join query.
 */
export const resolveJoins = (
  sql: SqlClient.SqlClient,
  mainRecords: ReadonlyArray<Record<string, unknown>>,
  joinConfig: JoinConfig,
): Effect.Effect<Record<string, unknown>[], unknown> =>
  pipe(
    Object.entries(joinConfig),
    Option.liftPredicate((entries) => entries.length > 0 && mainRecords.length > 0),
    Option.match({
      onNone: () => Effect.succeed(mainRecords.map((r) => ({ ...r }))),
      onSome: (joinEntries) =>
        joinEntries.reduce<Effect.Effect<Record<string, unknown>[], unknown>>(
          (acc, [joinedTable, joinEntry]) =>
            Effect.flatMap(acc, (currentResults) =>
              resolveJoinEntry(sql, mainRecords, currentResults, joinedTable, joinEntry),
            ),
          Effect.succeed(mainRecords.map((r) => ({ ...r }))),
        ),
    }),
  )
