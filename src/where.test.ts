import { SqliteClient } from '@effect/sql-sqlite-node'
import { describe, expect, it, layer } from '@effect/vitest'
import type { CleanedWhere } from 'better-auth/adapters'
import { Effect, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import type { Dialect } from './dialect'
import { toSqlValue, whereCondition } from './where'

const where = (
  field: string,
  operator: NonNullable<CleanedWhere['operator']>,
  value: CleanedWhere['value'],
  extra: Partial<Pick<CleanedWhere, 'connector' | 'mode'>> = {},
): CleanedWhere => ({ field, operator, value, connector: 'AND', mode: 'sensitive', ...extra })

const Sqlite = SqliteClient.layer({ filename: ':memory:' })

/** Compiles `SELECT * FROM "t" WHERE …` (identifiers and placeholders as SQLite renders them). */
const compile = (dialect: Dialect, conditions: ReadonlyArray<CleanedWhere>) =>
  Effect.map(SqlClient.SqlClient, (sql) =>
    Option.match(whereCondition(sql, dialect, conditions), {
      onNone: () => null,
      onSome: (condition) => sql`SELECT * FROM ${sql('t')} WHERE ${condition}`.compile(),
    }),
  )

layer(Sqlite)('whereCondition: SQL', (it) => {
  it.effect('is None without conditions', () =>
    Effect.gen(function* () {
      expect(yield* compile('sqlite', [])).toBeNull()
    }),
  )

  it.effect('maps null equality to IS NULL / IS NOT NULL', () =>
    Effect.gen(function* () {
      expect(yield* compile('pg', [where('a', 'eq', null), where('b', 'ne', null)])).toEqual([
        'SELECT * FROM "t" WHERE ("a" IS NULL AND "b" IS NOT NULL)',
        [],
      ])
    }),
  )

  it.effect('groups as (AND …) AND (OR …)', () =>
    Effect.gen(function* () {
      const [query] =
        (yield* compile('pg', [
          where('a', 'eq', 1),
          where('b', 'eq', 2, { connector: 'OR' }),
          where('c', 'eq', 3),
          where('d', 'eq', 4, { connector: 'OR' }),
        ])) ?? []
      expect(query).toBe('SELECT * FROM "t" WHERE (("a" = ? AND "c" = ?) AND ("b" = ? OR "d" = ?))')
    }),
  )

  it.effect('turns empty in / not_in into constant conditions', () =>
    Effect.gen(function* () {
      expect(yield* compile('pg', [where('a', 'in', [])])).toEqual(['SELECT * FROM "t" WHERE 1 = 0', []])
      expect(yield* compile('pg', [where('a', 'not_in', [])])).toEqual(['SELECT * FROM "t" WHERE 1 = 1', []])
    }),
  )

  it.effect('parenthesizes a single-value insensitive list', () =>
    Effect.gen(function* () {
      expect(yield* compile('sqlite', [where('a', 'not_in', ['X'], { mode: 'insensitive' })])).toEqual([
        'SELECT * FROM "t" WHERE LOWER("a") NOT IN (LOWER(?))',
        ['X'],
      ])
    }),
  )

  it.effect('escapes LIKE wildcards and uses ILIKE on PostgreSQL for insensitive matching', () =>
    Effect.gen(function* () {
      expect(yield* compile('pg', [where('a', 'contains', '50%_off!')])).toEqual([
        `SELECT * FROM "t" WHERE "a" LIKE ? ESCAPE '!'`,
        ['%50!%!_off!!%'],
      ])
      expect(yield* compile('pg', [where('a', 'starts_with', 'Ab', { mode: 'insensitive' })])).toEqual([
        `SELECT * FROM "t" WHERE "a" ILIKE ? ESCAPE '!'`,
        ['Ab%'],
      ])
      expect(yield* compile('mysql', [where('a', 'ends_with', 'Ab', { mode: 'insensitive' })])).toEqual([
        `SELECT * FROM "t" WHERE LOWER("a") LIKE LOWER(?) ESCAPE '!'`,
        ['%Ab'],
      ])
    }),
  )

  it.effect('uses case-sensitive GLOB on SQLite, escaping glob metacharacters', () =>
    Effect.gen(function* () {
      expect(yield* compile('sqlite', [where('a', 'contains', 'a*b?[c')])).toEqual([
        'SELECT * FROM "t" WHERE "a" GLOB ?',
        ['*a[*]b[?][[]c*'],
      ])
    }),
  )

  it.effect('compares strings exactly on MySQL with a binary collation, keeping the indexable comparison', () =>
    Effect.gen(function* () {
      expect(yield* compile('mysql', [where('a', 'eq', 'X')])).toEqual([
        'SELECT * FROM "t" WHERE ("a" = ? AND "a" = (? COLLATE utf8mb4_bin))',
        ['X', 'X'],
      ])
      expect(yield* compile('mysql', [where('a', 'in', ['X', 'y'])])).toEqual([
        'SELECT * FROM "t" WHERE ("a" IN (?,?) AND "a" IN ((? COLLATE utf8mb4_bin), (? COLLATE utf8mb4_bin)))',
        ['X', 'y', 'X', 'y'],
      ])
      expect(yield* compile('mysql', [where('a', 'ne', 'X'), where('b', 'not_in', ['X'])])).toEqual([
        'SELECT * FROM "t" WHERE ("a" <> (? COLLATE utf8mb4_bin) AND "b" NOT IN ((? COLLATE utf8mb4_bin)))',
        ['X', 'X'],
      ])
      expect(yield* compile('mysql', [where('a', 'starts_with', 'Ab')])).toEqual([
        `SELECT * FROM "t" WHERE "a" LIKE (? COLLATE utf8mb4_bin) ESCAPE '!'`,
        ['Ab%'],
      ])
    }),
  )

  it.effect('leaves non-string comparisons on MySQL alone', () =>
    Effect.gen(function* () {
      expect(yield* compile('mysql', [where('a', 'eq', 5), where('b', 'in', [1, 2])])).toEqual([
        'SELECT * FROM "t" WHERE ("a" = ? AND "b" IN (?,?))',
        [5, 1, 2],
      ])
    }),
  )

  it.effect('only applies insensitive mode to strings', () =>
    Effect.gen(function* () {
      expect(yield* compile('pg', [where('a', 'eq', 5, { mode: 'insensitive' })])).toEqual([
        'SELECT * FROM "t" WHERE "a" = ?',
        [5],
      ])
    }),
  )
})

describe('toSqlValue', () => {
  it('converts what the dialect cannot bind', () => {
    const date = new Date('2026-01-02T03:04:05.000Z')
    const sqlite = toSqlValue({
      supportsDates: false,
      supportsBooleans: false,
      supportsJSON: false,
      supportsArrays: false,
      supportsUUIDs: false,
    })
    expect([sqlite(date), sqlite(true), sqlite(false), sqlite('x'), sqlite(1), sqlite(null)]).toEqual([
      '2026-01-02T03:04:05.000Z',
      1,
      0,
      'x',
      1,
      null,
    ])
    const pg = toSqlValue({
      supportsDates: true,
      supportsBooleans: true,
      supportsJSON: false,
      supportsArrays: false,
      supportsUUIDs: true,
    })
    expect([pg(date), pg(true)]).toEqual([date, true])
  })
})

const names = ['abc', 'ABC', '50%_off', '50 off', 'a*b', 'axb']

/** A table `t` with one row per name. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE t (name text, flag integer, at text)`
  yield* Effect.forEach(
    names,
    (name, i) =>
      sql`INSERT INTO t ${sql.insert({ name, flag: i % 2, at: new Date(Date.UTC(2026, 0, i + 1)).toISOString() })}`,
    { discard: true },
  )
})

/** The names of the rows of `t` that `conditions` select. */
const matching = (conditions: ReadonlyArray<CleanedWhere>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* Option.match(whereCondition(sql, 'sqlite', conditions), {
      onNone: () => sql<{ name: string }>`SELECT name FROM t ORDER BY rowid`,
      onSome: (condition) => sql<{ name: string }>`SELECT name FROM t WHERE ${condition} ORDER BY rowid`,
    })
    return rows.map((row) => row.name)
  })

// A fresh database per test: each one seeds the same table.
layer(Sqlite, { buildPerTest: true })('whereCondition: behavior on SQLite', (it) => {
  it.effect('matches LIKE wildcards literally', () =>
    Effect.gen(function* () {
      yield* seed
      expect(yield* matching([where('name', 'contains', '%_')])).toEqual(['50%_off'])
      expect(yield* matching([where('name', 'contains', '*')])).toEqual(['a*b'])
    }),
  )

  it.effect('distinguishes case in sensitive mode and ignores it in insensitive mode', () =>
    Effect.gen(function* () {
      yield* seed
      expect(yield* matching([where('name', 'starts_with', 'ab')])).toEqual(['abc'])
      expect(yield* matching([where('name', 'starts_with', 'ab', { mode: 'insensitive' })])).toEqual(['abc', 'ABC'])
      expect(yield* matching([where('name', 'eq', 'abc', { mode: 'insensitive' })])).toEqual(['abc', 'ABC'])
    }),
  )

  it.effect('converts booleans and dates inside in-lists', () =>
    Effect.gen(function* () {
      yield* seed
      expect(yield* matching([where('flag', 'in', [true] as unknown as CleanedWhere['value'])])).toEqual([
        'ABC',
        '50 off',
        'axb',
      ])
      expect(
        yield* matching([
          where('at', 'in', [
            new Date(Date.UTC(2026, 0, 1)),
            new Date(Date.UTC(2026, 0, 2)),
          ] as unknown as CleanedWhere['value']),
        ]),
      ).toEqual(['abc', 'ABC'])
    }),
  )
})
