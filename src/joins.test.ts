import { SqliteClient } from '@effect/sql-sqlite-node'
import { expect, layer } from '@effect/vitest'
import type { JoinConfig } from 'better-auth/adapters'
import { Effect, Ref } from 'effect'
import { SqlClient, Statement } from 'effect/sql'
import { attachJoins } from './joins'

const child = (relation: 'one-to-one' | 'one-to-many'): JoinConfig => ({
  child: { on: { from: 'id', to: 'parentId' }, limit: relation === 'one-to-one' ? 1 : 10, relation },
})

/** Joins `child` rows onto the given parents and returns them with the statements that ran. */
const joined = (relation: 'one-to-one' | 'one-to-many', parents: ReadonlyArray<{ readonly id: string }>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const log = yield* Ref.make<ReadonlyArray<string>>([])
    const record: Statement.Transformer = (statement) =>
      Effect.as(
        Ref.update(log, (all) => [...all, statement.compile()[0]]),
        statement,
      )
    const rows = yield* attachJoins(sql, child(relation), parents).pipe(
      Effect.provideService(Statement.CurrentTransformer, record),
    )
    return { rows, statements: yield* Ref.get(log) }
  })

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE child (id text, parentId text)`
  yield* sql`INSERT INTO child ${sql.insert([
    { id: 'c1', parentId: 'p1' },
    { id: 'c2', parentId: 'p1' },
  ])}`
})

layer(SqliteClient.layer({ filename: ':memory:' }), { buildPerTest: true })('attachJoins', (it) => {
  it.effect('finds no children for a key named like an Object.prototype property', () =>
    Effect.gen(function* () {
      yield* seed
      const parents = [{ id: 'constructor' }, { id: 'toString' }, { id: '__proto__' }]
      expect((yield* joined('one-to-many', parents)).rows).toEqual([
        { id: 'constructor', child: [] },
        { id: 'toString', child: [] },
        { id: '__proto__', child: [] },
      ])
      expect((yield* joined('one-to-one', parents)).rows).toEqual([
        { id: 'constructor', child: null },
        { id: 'toString', child: null },
        { id: '__proto__', child: null },
      ])
    }),
  )

  it.effect('limits one-to-many joins per parent, and leaves one-to-one joins a plain IN', () =>
    Effect.gen(function* () {
      yield* seed
      const many = yield* joined('one-to-many', [{ id: 'p1' }])
      expect(many.statements[0]).toMatch(/ROW_NUMBER\(\) OVER/)
      expect(many.rows).toEqual([{ id: 'p1', child: [expect.anything(), expect.anything()] }])
      const one = yield* joined('one-to-one', [{ id: 'p1' }])
      expect(one.statements[0]).not.toMatch(/ROW_NUMBER/)
      expect(one.statements[0]).toMatch(/WHERE "parentId" IN \(\?\)$/)
      expect(one.rows).toEqual([{ id: 'p1', child: { id: 'c1', parentId: 'p1' } }])
    }),
  )
})
