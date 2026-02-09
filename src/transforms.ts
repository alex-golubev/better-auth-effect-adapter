import { Match, Option, pipe } from 'effect'
import type { Primitive, SqlData } from './types.js'

/**
 * Retrieves the number of affected rows from the given input.
 * If the input is a valid object and contains an `affectedRows`, `rowCount`,
 * or `changes` property with a numeric value, that value is returned.
 * Otherwise, defaults to 0.
 *
 * @param {unknown} raw - The input data to extract the affected rows from.
 * @returns {number} The number of affected rows, or 0 if the extraction fails.
 */
export const getAffectedRows = (raw: unknown): number =>
  pipe(
    raw,
    Option.liftPredicate((v): v is Record<string, unknown> => typeof v === 'object' && v !== null),
    Option.flatMap((r) => Option.fromNullable(r.affectedRows ?? r.rowCount ?? r.changes)),
    Option.filter((v): v is number => typeof v === 'number'),
    Option.getOrElse(() => 0),
  )

/**
 * Checks if the provided value is a plain object or an array.
 * A plain object is defined as an object that directly inherits from `Object.prototype`.
 *
 * @param {unknown} value - The value to check.
 * @returns {value is Record<string, unknown> | unknown[]} - Returns `true`
 * if the value is a plain object or an array, otherwise `false`.
 */
const isPlainObjectOrArray = (value: unknown): value is Record<string, unknown> | unknown[] =>
  value !== null &&
  typeof value === 'object' &&
  (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)

/**
 * Determines whether the given value is a primitive data type or undefined.
 *
 * A value is considered primitive if it falls into one of the following categories:
 * - `null`
 * - `undefined`
 * - `string`
 * - `number`
 * - `bigint`
 * - `boolean`
 * - An instance of `Date`
 * - An instance of `Int8Array`
 * - An instance of `Uint8Array`
 *
 * @param value - The value to be checked.
 * @returns A boolean indicating whether the value is primitive or `undefined`.
 */
const isPrimitive = (value: unknown): value is Primitive | undefined =>
  value === null ||
  value === undefined ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'boolean' ||
  value instanceof Date ||
  value instanceof Int8Array ||
  value instanceof Uint8Array

/**
 * Safely serializes a JavaScript object or array into a JSON string, handling circular references.
 *
 * This function uses a `WeakSet` to track seen objects during the serialization process.
 * If a circular reference is detected, the corresponding value is replaced with `undefined`.
 *
 * @param {Record<string, unknown> | unknown[]} value - The object or array to be serialized.
 * @returns {string} The JSON string representation of the input value.
 */
const safeJsonStringify = (value: Record<string, unknown> | unknown[]): string => {
  const seen = new WeakSet()
  return JSON.stringify(value, (_, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return undefined
      seen.add(v)
    }
    return v
  })
}

/**
 * Converts a given value into its corresponding SQL-compatible representation.
 *
 * The function attempts to map various input types to appropriate SQL-compatible values:
 * - Dates are converted to ISO 8601 string format.
 * - Booleans are converted to integers (`1` for `true` and `0` for `false`).
 * - Primitive types (strings, numbers, etc.) are returned directly.
 * - Plain objects and arrays are serialized into JSON strings safely.
 * - All other types are converted to strings as a fallback.
 *
 * @param {unknown} value - The value to be converted.
 * @returns {Primitive | undefined} The SQL-compatible representation of the input value, or `undefined` for unsupported types.
 */
export const convertToSqlValue: (value: unknown) => Primitive | undefined = Match.type<unknown>().pipe(
  Match.when(Match.instanceOf(Date), (d) => d.toISOString()),
  Match.when(Match.boolean, (b) => (b ? 1 : 0)),
  Match.when(isPrimitive, (v) => v),
  Match.when(isPlainObjectOrArray, safeJsonStringify),
  Match.orElse((v) => String(v)),
)

/**
 * Converts a given object into an SQL-compatible data structure by processing
 * each key-value pair and transforming the values into a format suitable for SQL operations.
 *
 * @param {Record<string, unknown>} data - The input object containing key-value pairs to be transformed.
 * @returns {SqlData} A new object where the values have been converted into SQL-compatible formats.
 */
export const toSqlData = (data: Record<string, unknown>): SqlData =>
  Object.fromEntries(Object.entries(data).map(([key, value]) => [key, convertToSqlValue(value)]))
