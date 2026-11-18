/** Values as each database returns and compares them, beyond the types better-auth declares. */
import { describe, expect } from '@effect/vitest'
import type { BetterAuthOptions, Where } from 'better-auth'
import { Array, Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { make } from '../src/adapter'
import { type Dialect, dialectOf } from '../src/dialect'
import { type Database, mysqlDatabase, postgresDatabase, resetSchema, sqliteDatabase, withDatabase } from './harness'

const options: BetterAuthOptions = {
  plugins: [{ id: 'item', schema: { item: { fields: { name: { type: 'string' } } } } }],
}

const binaryTypes: Record<Dialect, string> = { sqlite: 'blob', pg: 'bytea', mysql: 'varbinary(16)' }

/** MySQL's worst case: under a PAD SPACE collation, `'abc'` equals `'abc '`. */
const padSpaceName: Record<Dialect, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  sqlite: Effect.void,
  pg: Effect.void,
  mysql: Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`ALTER TABLE ${sql('item')} MODIFY ${sql('name')} varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL`,
  ),
}

// The tests recreate `item` with other columns (see `preparedStatements`).
const databases: ReadonlyArray<readonly [string, Database]> = [
  ['sqlite', sqliteDatabase()],
  ['pg', postgresDatabase({ preparedStatements: false })],
  ['mysql', mysqlDatabase({ preparedStatements: false })],
]

describe.each(databases)('values (%s)', (_, database) => {
  withDatabase(database)((it) => {
    // An app may add such a column to an auth table: the adapter reads `SELECT *`, and better-auth's
    // factory drops the columns its schema doesn't declare only afterwards.
    it.effect('reads rows that hold a binary value', () =>
      Effect.gen(function* () {
        yield* resetSchema(options)
        const sql = yield* SqlClient.SqlClient
        const dialect = yield* dialectOf
        yield* sql`ALTER TABLE ${sql('item')} ADD COLUMN ${sql('avatar')} ${sql.literal(binaryTypes[dialect])}`
        yield* sql`INSERT INTO ${sql('item')} ${sql.insert({ id: 'a', name: 'a', avatar: Buffer.from([1, 2, 3]) })}`
        const adapter = (yield* make())(options)
        const byId = [{ field: 'id', value: 'a' }]
        const found = yield* Effect.promise(() => adapter.findOne<{ name: string }>({ model: 'item', where: byId }))
        const all = yield* Effect.promise(() => adapter.findMany<{ name: string }>({ model: 'item' }))
        const updated = yield* Effect.promise(() =>
          adapter.update<{ name: string }>({ model: 'item', where: byId, update: { name: 'b' } }),
        )
        expect(found?.name).toBe('a')
        expect(Array.map(all, (row) => row.name)).toEqual(['a'])
        expect(updated?.name).toBe('b')
      }),
    )

    it.effect('tells values apart by trailing spaces', () =>
      Effect.gen(function* () {
        yield* resetSchema(options)
        yield* padSpaceName[yield* dialectOf]
        const adapter = (yield* make())(options)
        yield* Effect.forEach(
          ['abc', 'abc '],
          (name) => Effect.promise(() => adapter.create({ model: 'item', data: { name } })),
          { discard: true },
        )
        const names = (where: ReadonlyArray<Where>) =>
          Effect.map(
            Effect.promise(() => adapter.findMany<{ name: string }>({ model: 'item', where: [...where] })),
            Array.map((row) => row.name),
          )
        expect(yield* names([{ field: 'name', value: 'abc' }])).toEqual(['abc'])
        expect(yield* names([{ field: 'name', value: 'abc ' }])).toEqual(['abc '])
        expect(yield* names([{ field: 'name', operator: 'ne', value: 'abc' }])).toEqual(['abc '])
        expect(yield* names([{ field: 'name', operator: 'in', value: ['abc'] }])).toEqual(['abc'])
        expect(yield* names([{ field: 'name', operator: 'not_in', value: ['abc'] }])).toEqual(['abc '])
      }),
    )
  })
})
