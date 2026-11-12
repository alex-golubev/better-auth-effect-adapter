import { SqliteClient } from '@effect/sql-sqlite-node'
import type { CleanedWhere } from 'better-auth/adapters'
import { Effect, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import { describe, expect, it } from 'vitest'
import type { Dialect } from './dialect'
import { toSqlValue, whereCondition } from './where'

const where = (
  field: string,
  operator: NonNullable<CleanedWhere['operator']>,
  value: CleanedWhere['value'],
  extra: Partial<Pick<CleanedWhere, 'connector' | 'mode'>> = {},
): CleanedWhere => ({ field, operator, value, connector: 'AND', mode: 'sensitive', ...extra })

const runSqlite = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, SqliteClient.layer({ filename: ':memory:' })))

/** Compiles `SELECT * FROM "t" WHERE …` (identifiers and placeholders as SQLite renders them). */
const compile = (dialect: Dialect, conditions: ReadonlyArray<CleanedWhere>) =>
  runSqlite(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.sync(() =>
        Option.match(whereCondition(sql, dialect, conditions), {
          onNone: () => null,
          onSome: (condition) => sql`SELECT * FROM ${sql('t')} WHERE ${condition}`.compile(),
        }),
      ),
    ),
  )

describe('whereCondition: SQL', () => {
  it('is None without conditions', async () => {
    expect(await compile('sqlite', [])).toBeNull()
  })

  it('maps null equality to IS NULL / IS NOT NULL', async () => {
    expect(await compile('pg', [where('a', 'eq', null), where('b', 'ne', null)])).toEqual([
      'SELECT * FROM "t" WHERE ("a" IS NULL AND "b" IS NOT NULL)',
      [],
    ])
  })

  it('groups as (AND …) AND (OR …)', async () => {
    const [query] = (await compile('pg', [
      where('a', 'eq', 1),
      where('b', 'eq', 2, { connector: 'OR' }),
      where('c', 'eq', 3),
      where('d', 'eq', 4, { connector: 'OR' }),
    ])) ?? ['']
    expect(query).toBe('SELECT * FROM "t" WHERE (("a" = ? AND "c" = ?) AND ("b" = ? OR "d" = ?))')
  })

  it('turns empty in / not_in into constant conditions', async () => {
    expect(await compile('pg', [where('a', 'in', [])])).toEqual(['SELECT * FROM "t" WHERE 1 = 0', []])
    expect(await compile('pg', [where('a', 'not_in', [])])).toEqual(['SELECT * FROM "t" WHERE 1 = 1', []])
  })

  it('parenthesizes a single-value insensitive list', async () => {
    expect(await compile('sqlite', [where('a', 'not_in', ['X'], { mode: 'insensitive' })])).toEqual([
      'SELECT * FROM "t" WHERE LOWER("a") NOT IN (LOWER(?))',
      ['X'],
    ])
  })

  it('escapes LIKE wildcards and uses ILIKE on PostgreSQL for insensitive matching', async () => {
    expect(await compile('pg', [where('a', 'contains', '50%_off!')])).toEqual([
      `SELECT * FROM "t" WHERE "a" LIKE ? ESCAPE '!'`,
      ['%50!%!_off!!%'],
    ])
    expect(await compile('pg', [where('a', 'starts_with', 'Ab', { mode: 'insensitive' })])).toEqual([
      `SELECT * FROM "t" WHERE "a" ILIKE ? ESCAPE '!'`,
      ['Ab%'],
    ])
    expect(await compile('mysql', [where('a', 'ends_with', 'Ab', { mode: 'insensitive' })])).toEqual([
      `SELECT * FROM "t" WHERE LOWER("a") LIKE LOWER(?) ESCAPE '!'`,
      ['%Ab'],
    ])
  })

  it('uses case-sensitive GLOB on SQLite, escaping glob metacharacters', async () => {
    expect(await compile('sqlite', [where('a', 'contains', 'a*b?[c')])).toEqual([
      'SELECT * FROM "t" WHERE "a" GLOB ?',
      ['*a[*]b[?][[]c*'],
    ])
  })

  it('only applies insensitive mode to strings', async () => {
    expect(await compile('pg', [where('a', 'eq', 5, { mode: 'insensitive' })])).toEqual([
      'SELECT * FROM "t" WHERE "a" = ?',
      [5],
    ])
  })
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

describe('whereCondition: behavior on SQLite', () => {
  const names = ['abc', 'ABC', '50%_off', '50 off', 'a*b', 'axb']

  const matching = (conditions: ReadonlyArray<CleanedWhere>) =>
    runSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE t (name text, flag integer, at text)`
        yield* Effect.forEach(
          names,
          (name, i) =>
            sql`INSERT INTO t ${sql.insert({ name, flag: i % 2, at: new Date(Date.UTC(2026, 0, i + 1)).toISOString() })}`,
          { discard: true },
        )
        const rows = yield* Option.match(whereCondition(sql, 'sqlite', conditions), {
          onNone: () => sql<{ name: string }>`SELECT name FROM t ORDER BY rowid`,
          onSome: (condition) => sql<{ name: string }>`SELECT name FROM t WHERE ${condition} ORDER BY rowid`,
        })
        return rows.map((row) => row.name)
      }),
    )

  it('matches LIKE wildcards literally', async () => {
    expect(await matching([where('name', 'contains', '%_')])).toEqual(['50%_off'])
    expect(await matching([where('name', 'contains', '*')])).toEqual(['a*b'])
  })

  it('distinguishes case in sensitive mode and ignores it in insensitive mode', async () => {
    expect(await matching([where('name', 'starts_with', 'ab')])).toEqual(['abc'])
    expect(await matching([where('name', 'starts_with', 'ab', { mode: 'insensitive' })])).toEqual(['abc', 'ABC'])
    expect(await matching([where('name', 'eq', 'abc', { mode: 'insensitive' })])).toEqual(['abc', 'ABC'])
  })

  it('converts booleans and dates inside in-lists', async () => {
    expect(await matching([where('flag', 'in', [true] as unknown as CleanedWhere['value'])])).toEqual([
      'ABC',
      '50 off',
      'axb',
    ])
    expect(
      await matching([
        where('at', 'in', [
          new Date(Date.UTC(2026, 0, 1)),
          new Date(Date.UTC(2026, 0, 2)),
        ] as unknown as CleanedWhere['value']),
      ]),
    ).toEqual(['abc', 'ABC'])
  })
})
