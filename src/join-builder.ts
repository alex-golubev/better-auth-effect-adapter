import { Effect, Option, pipe } from 'effect'
import type { SqlClient } from '@effect/sql'
import type { Primitive } from './types.js'

/**
 * Represents a configuration entry for defining join parameters in a data relationship.
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

const DEFAULT_JOIN_LIMIT = 100

/**
 * Extracts unique primitive values from a specified column in an array of records.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} records - An array of objects containing the data to process.
 * @param {string} columnName - The key of the column from which values should be collected.
 * @returns {Primitive[]} An array of unique primitive values from the specified column, excluding null and undefined.
 */
export const collectJoinValues = (records: ReadonlyArray<Record<string, unknown>>, columnName: string): Primitive[] => [
  ...new Set(records.map((r) => r[columnName]).filter((v): v is Primitive => v !== null && v !== undefined)),
]

/**
 * Constructs a join index from an array of rows based on a specified key column.
 *
 * This function creates a Map where the keys are derived from the specified key column
 * in each row, and the values are arrays of rows that share the same key. Rows with null
 * or undefined key values are excluded from the resulting Map.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows - The array of rows to process. Each row is represented as an object with string keys and values of any type.
 * @param {string} keyColumn - The name of the column to use as the key for the index.
 * The value in this column is used to group rows with the same key.
 * @returns {Map<unknown, Record<string, unknown>[]>} A Map where each key is the value
 * from the specified column, and each value is an array of rows that contain this key value.
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
 * Retrieves matching records from an indexed data structure based on a given key value.
 *
 * @param {Map<unknown, Record<string, unknown>[]>} index - A map that associates keys with an array of records.
 * @param {unknown} keyValue - The key to look up in the index.
 * @returns {Record<string, unknown>[]} An array of records associated with the specified key, or an empty array if no matches are found.
 */
const lookupMatches = (index: Map<unknown, Record<string, unknown>[]>, keyValue: unknown): Record<string, unknown>[] =>
  pipe(
    Option.fromNullable(keyValue),
    Option.flatMap((key) => Option.fromNullable(index.get(key))),
    Option.getOrElse((): Record<string, unknown>[] => []),
  )

/**
 * Resolves an attached value from matching rows based on the specified join configuration entry.
 *
 * The function determines the relationship type from the provided `entry` parameter. If the relation is
 * identified as "one-to-one," it returns the first matching row or `null` if no rows are available.
 * For "one-to-many" relationships, it returns a subset of matching rows up to the specified `limit`
 * in `entry`, or the default join limit if no `limit` is specified in the configuration.
 *
 * @param {Record<string, unknown>[]} matchingRows - An array of record objects representing the matching rows from a query.
 * @param {JoinConfigEntry} entry - An object containing the configuration for the join operation, including relation type and optional limit.
 * @returns {Record<string, unknown> | Record<string, unknown>[] | null}
 * Returns either a single record for "one-to-one" relations, an array of records for "one-to-many" relations, or `null` if no rows are resolved.
 */
const resolveAttachedValue = (
  matchingRows: Record<string, unknown>[],
  entry: JoinConfigEntry,
): Record<string, unknown> | Record<string, unknown>[] | null =>
  (entry.relation ?? 'one-to-many') === 'one-to-one'
    ? (matchingRows[0] ?? null)
    : matchingRows.slice(0, entry.limit ?? DEFAULT_JOIN_LIMIT)

/**
 * Attaches join results to the main records by matching them with entries
 * from a joined table based on specified join configurations.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} mainRecords - The primary set of records to which joined results will be attached.
 * @param {string} joinedTableName - The name of the table containing the joined data. This will be used as the key for the attached data in the resulting records.
 * @param {JoinConfigEntry} joinEntry - Configuration specifying how the join should be performed, including the matching fields between tables.
 * @param {ReadonlyArray<Record<string, unknown>>} joinedRows - The rows from the joined table that will be matched to the main records based on the join configuration.
 * @returns {Record<string, unknown>[]} A new array of records where each record from the main table includes the attached data from the joined table.
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

/**
 * Resolves the join entry by executing a SQL query to fetch related rows from the joined table based on the join configuration.
 * The method attaches the fetched rows to the current results and returns the updated results.
 *
 * @param {SqlClient.SqlClient} sql - The SQL client used to execute the database query.
 * @param {ReadonlyArray<Record<string, unknown>>} mainRecords - The main records used as the source for extracting join criteria values.
 * @param {Record<string, unknown>[]} currentResults - The currently accumulated result set to which the join results will be added.
 * @param {string} joinedTable - The name of the table to join with.
 * @param {JoinConfigEntry} joinEntry - The configuration defining the join conditions, including the fields to match.
 * @returns {Effect.Effect<Record<string, unknown>[], unknown>} An Effect that resolves to the updated result set with the join data attached or handles the absence of matching records.
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
 * Processes and resolves join configurations for a set of main records, applying transformations
 * according to the provided join rules and leveraging a SQL client for querying related data.
 *
 * @param {SqlClient.SqlClient} sql - The SQL client used to execute queries against the database.
 * @param {ReadonlyArray<Record<string, unknown>>} mainRecords - The primary records for which the join configurations will be applied.
 * @param {JoinConfig} joinConfig - An object representing the join configurations, where each key maps to a table and its associated join rules.
 * @returns {Effect.Effect<Record<string, unknown>[], unknown>} An Effect that resolves into an array of transformed records
 * after applying the specified joins.
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
