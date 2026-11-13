import { SqliteClient } from '@effect/sql-sqlite-node'
import { describe, expect, it, layer } from '@effect/vitest'
import type { BetterAuthOptions } from 'better-auth'
import { Context, Data, Effect, Ref, String as Str } from 'effect'
import { SqlClient, SqlError, Statement } from 'effect/sql'
import { fromContext, make } from './adapter'
import { EffectSqlAdapterError } from './errors'

// Only what dialect detection touches.
const unsupportedClient = {
  driver: 'mssql',
  onDialectOrElse: (cases: { readonly orElse: () => unknown }) => cases.orElse(),
} as unknown as SqlClient.SqlClient

const unsupportedContext = Context.make(SqlClient.SqlClient, unsupportedClient)

const Sqlite = SqliteClient.layer({ filename: ':memory:' })

class Rejected extends Data.TaggedError('Rejected')<{ readonly cause: unknown }> {}

const statementsOf = (code: string) => code.split(';').filter((statement) => statement.trim() !== '')

const adapterFor = (options: BetterAuthOptions) => Effect.map(make(), (adapter) => adapter(options))

const adapterWithSchema = (options: BetterAuthOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const adapter = yield* adapterFor(options)
    const schema = yield* Effect.promise(() => adapter.createSchema?.(options, undefined) ?? Promise.resolve(undefined))
    yield* Effect.forEach(statementsOf(schema?.code ?? ''), (statement) => sql.unsafe(statement), { discard: true })
    return adapter
  })

describe('make', () => {
  it.effect('builds an adapter factory on a supported dialect', () =>
    Effect.gen(function* () {
      expect(yield* make()).toBeTypeOf('function')
    }).pipe(Effect.provide(Sqlite)),
  )

  it.effect('fails with EffectSqlAdapterError on an unsupported dialect', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.provideContext(make(), unsupportedContext))
      expect(error).toBeInstanceOf(EffectSqlAdapterError)
      expect(error.message).toMatch(/driver "mssql"/)
    }),
  )
})

describe('fromContext', () => {
  it.effect('builds an adapter factory from a captured context', () =>
    Effect.gen(function* () {
      expect(fromContext(yield* Effect.context<SqlClient.SqlClient>())).toBeTypeOf('function')
    }).pipe(Effect.provide(Sqlite)),
  )

  // fromContext throws: it serves apps outside Effect.
  it('throws the EffectSqlAdapterError itself on an unsupported dialect', () => {
    expect(() => fromContext(unsupportedContext)).toThrow(EffectSqlAdapterError)
  })
})

layer(Sqlite, { buildPerTest: true })('adapter on SQLite', (it) => {
  it.effect('generates the schema for `npx auth generate`', () =>
    Effect.gen(function* () {
      const adapter = yield* adapterFor({})
      expect(
        yield* Effect.promise(() => adapter.createSchema?.({}, undefined) ?? Promise.resolve(undefined)),
      ).toMatchObject({
        path: 'better-auth-schema.sql',
        code: expect.stringContaining('CREATE TABLE "user"'),
      })
      expect(
        yield* Effect.promise(() => adapter.createSchema?.({}, '/tmp/out/schema.sql') ?? Promise.resolve(undefined)),
      ).toMatchObject({ path: '/tmp/out/schema.sql' })
    }),
  )

  it.effect('rejects with the original SqlError, classified by reason', () =>
    Effect.gen(function* () {
      const adapter = yield* adapterWithSchema({})
      yield* Effect.promise(() => adapter.create({ model: 'user', data: { name: 'A', email: 'dup@example.com' } }))
      const { cause } = yield* Effect.flip(
        Effect.tryPromise({
          try: () => adapter.create({ model: 'user', data: { name: 'B', email: 'dup@example.com' } }),
          catch: (cause) => new Rejected({ cause }),
        }),
      )
      expect(SqlError.isSqlError(cause)).toBe(true)
      expect(SqlError.isSqlError(cause) && cause.reason._tag).toBe('UniqueViolation')
    }),
  )
})

describe('adapter with name transforms', () => {
  it.effect("generates the names the client's transformQueryNames gives the adapter's queries", () =>
    Effect.gen(function* () {
      const adapter = yield* adapterFor({})
      const created = yield* Effect.promise(() => adapter.createSchema?.({}, undefined) ?? Promise.resolve(undefined))
      expect(created?.code).toContain('"email_verified" integer NOT NULL')
      expect(created?.code).toContain('FOREIGN KEY ("user_id") REFERENCES "user" ("id")')
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:', transformQueryNames: Str.camelToSnake }))),
  )
})

const recorded = (options: BetterAuthOptions) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<string>>([])
    const record: Statement.Transformer = (statement) =>
      Effect.as(
        Ref.update(log, (all) => [...all, statement.compile()[0]]),
        statement,
      )
    const adapter = yield* adapterWithSchema(options).pipe(Effect.provideService(Statement.CurrentTransformer, record))
    const traced = <A>(call: () => Promise<A>) =>
      Effect.gen(function* () {
        yield* Ref.set(log, [])
        const result = yield* Effect.promise(call)
        return { result, statements: yield* Ref.get(log) }
      })
    return { adapter, traced }
  })

layer(Sqlite, { buildPerTest: true })('native operations on SQLite', (it) => {
  it.effect('consumeOne deletes and returns one row in a single statement, then finds nothing', () =>
    Effect.gen(function* () {
      const { adapter, traced } = yield* recorded({})
      const expiresAt = new Date(Date.now() + 60_000)
      yield* Effect.forEach(
        ['1', '2'],
        (value) =>
          Effect.promise(() =>
            adapter.create({ model: 'verification', data: { identifier: 'otp', value, expiresAt } }),
          ),
        { discard: true },
      )
      const where = [{ field: 'identifier', value: 'otp' }]
      const first = yield* traced(() => adapter.consumeOne<{ value: string }>({ model: 'verification', where }))
      expect(first.statements).toHaveLength(1)
      expect(first.statements[0]).toMatch(/^DELETE .* RETURNING \*$/)
      const second = yield* Effect.promise(() =>
        adapter.consumeOne<{ value: string }>({ model: 'verification', where }),
      )
      expect([first.result?.value, second?.value].sort()).toEqual(['1', '2'])
      expect(yield* Effect.promise(() => adapter.consumeOne({ model: 'verification', where }))).toBeNull()
    }),
  )

  it.effect('incrementOne updates one row in a single statement and respects the guard', () =>
    Effect.gen(function* () {
      const { adapter, traced } = yield* recorded({ rateLimit: { enabled: true, storage: 'database' } })
      yield* Effect.promise(() => adapter.create({ model: 'rateLimit', data: { key: 'ip', count: 1, lastRequest: 1 } }))
      const bumped = yield* traced(() =>
        adapter.incrementOne<{ count: number; lastRequest: number }>({
          model: 'rateLimit',
          where: [{ field: 'key', value: 'ip' }],
          increment: { count: 2 },
          set: { lastRequest: 5 },
        }),
      )
      expect(bumped.statements).toHaveLength(1)
      expect(bumped.result).toMatchObject({ count: 3, lastRequest: 5 })
      const missed = yield* Effect.promise(() =>
        adapter.incrementOne({
          model: 'rateLimit',
          where: [
            { field: 'key', value: 'ip' },
            { field: 'count', value: 1 },
          ],
          increment: { count: 1 },
        }),
      )
      expect(missed).toBeNull()
    }),
  )

  it.effect('resolves joins with one query per joined table instead of one per row', () =>
    Effect.gen(function* () {
      const { adapter, traced } = yield* recorded({ advanced: { database: { joins: true } } })
      const users = yield* Effect.forEach(['a', 'b', 'c'], (name) =>
        Effect.promise(() =>
          adapter.create<{ id: string }>({ model: 'user', data: { name, email: `${name}@example.com` } }),
        ),
      )
      yield* Effect.forEach(
        users.flatMap((user) => [1, 2].map((n) => ({ user, n }))),
        ({ user, n }) =>
          Effect.promise(() =>
            adapter.create({
              model: 'session',
              data: {
                userId: user.id,
                token: `${user.id}-${n}`,
                expiresAt: new Date(Date.now() + 60_000),
                updatedAt: new Date(),
              },
            }),
          ),
        { discard: true },
      )
      const found = yield* traced(() =>
        adapter.findMany<{ session: ReadonlyArray<unknown> }>({ model: 'user', join: { session: true } }),
      )
      expect(found.statements).toHaveLength(2)
      expect(found.result.map((user) => user.session.length)).toEqual([2, 2, 2])
    }),
  )
})
