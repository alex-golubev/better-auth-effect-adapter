import { SqliteClient } from '@effect/sql-sqlite-node'
import type { BetterAuthOptions } from 'better-auth'
import { Context, Effect, ManagedRuntime, Ref, String as Str } from 'effect'
import { SqlClient, SqlError, Statement } from 'effect/sql'
import { describe, expect, it } from 'vitest'
import { fromContext, make } from './adapter'
import { EffectSqlAdapterError } from './errors'

// Only what dialect detection touches.
const unsupportedClient = {
  driver: 'mssql',
  onDialectOrElse: (cases: { readonly orElse: () => unknown }) => cases.orElse(),
} as unknown as SqlClient.SqlClient

const unsupportedContext = Context.make(SqlClient.SqlClient, unsupportedClient)

describe('make', () => {
  it('builds an adapter factory on a supported dialect', async () => {
    const adapter = await Effect.runPromise(Effect.provide(make(), SqliteClient.layer({ filename: ':memory:' })))
    expect(adapter).toBeTypeOf('function')
  })

  it('fails with EffectSqlAdapterError on an unsupported dialect', () => {
    const error = Effect.runSync(Effect.flip(Effect.provideContext(make(), unsupportedContext)))
    expect(error).toBeInstanceOf(EffectSqlAdapterError)
    expect(error.message).toMatch(/driver "mssql"/)
  })
})

describe('fromContext', () => {
  it('builds an adapter factory from a captured context', async () => {
    const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: ':memory:' }))
    expect(fromContext(await runtime.context())).toBeTypeOf('function')
    await runtime.dispose()
  })

  it('throws the EffectSqlAdapterError itself on an unsupported dialect', () => {
    expect(() => fromContext(unsupportedContext)).toThrow(EffectSqlAdapterError)
  })
})

describe('adapter on SQLite', () => {
  const withAdapter = async <A>(use: (adapter: ReturnType<ReturnType<typeof fromContext>>) => Promise<A>) => {
    const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: ':memory:' }))
    const adapter = fromContext(await runtime.context())({})
    const created = await adapter.createSchema?.({}, undefined)
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.forEach(
          (created?.code ?? '').split(';').filter((statement) => statement.trim() !== ''),
          (statement) => sql.unsafe(statement),
        ),
      ),
    )
    return use(adapter).finally(() => runtime.dispose())
  }

  it('generates the schema for `npx auth generate`', async () => {
    const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: ':memory:' }))
    const adapter = fromContext(await runtime.context())({})
    expect(await adapter.createSchema?.({}, undefined)).toMatchObject({
      path: 'better-auth-schema.sql',
      code: expect.stringContaining('CREATE TABLE "user"'),
    })
    expect(await adapter.createSchema?.({}, '/tmp/out/schema.sql')).toMatchObject({ path: '/tmp/out/schema.sql' })
    await runtime.dispose()
  })

  it("generates the names the client's transformQueryNames gives the adapter's queries", async () => {
    const runtime = ManagedRuntime.make(
      SqliteClient.layer({ filename: ':memory:', transformQueryNames: Str.camelToSnake }),
    )
    const adapter = fromContext(await runtime.context())({})
    const created = await adapter.createSchema?.({}, undefined)
    expect(created?.code).toContain('"email_verified" integer NOT NULL')
    expect(created?.code).toContain('FOREIGN KEY ("user_id") REFERENCES "user" ("id")')
    await runtime.dispose()
  })

  it('rejects with the original SqlError, classified by reason', async () => {
    const error = await withAdapter(async (adapter) => {
      await adapter.create({ model: 'user', data: { name: 'A', email: 'dup@example.com' } })
      return adapter.create({ model: 'user', data: { name: 'B', email: 'dup@example.com' } }).then(
        () => undefined,
        (e: unknown) => e,
      )
    })
    expect(SqlError.isSqlError(error)).toBe(true)
    expect(SqlError.isSqlError(error) && error.reason._tag).toBe('UniqueViolation')
  })
})

describe('native operations on SQLite', () => {
  /** An adapter whose statements are recorded, on a database with the schema for `options`. */
  const recorded = async (options: BetterAuthOptions) => {
    const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: ':memory:' }))
    const log = Ref.makeUnsafe<ReadonlyArray<string>>([])
    const record: Statement.Transformer = (statement) =>
      Effect.as(
        Ref.update(log, (all) => [...all, statement.compile()[0]]),
        statement,
      )
    const context = Context.add(await runtime.context(), Statement.CurrentTransformer, record)
    const adapter = fromContext(context)(options)
    const schema = await adapter.createSchema?.(options, undefined)
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.forEach(
          (schema?.code ?? '').split(';').filter((statement) => statement.trim() !== ''),
          (statement) => sql.unsafe(statement),
        ),
      ),
    )
    /** Runs `call` and returns its result with the statements it issued. */
    const traced = async <A>(call: () => Promise<A>) => {
      Effect.runSync(Ref.set(log, []))
      const result = await call()
      return { result, statements: Effect.runSync(Ref.get(log)) }
    }
    return { adapter, traced, dispose: () => runtime.dispose() }
  }

  it('consumeOne deletes and returns one row in a single statement, then finds nothing', async () => {
    const { adapter, traced, dispose } = await recorded({})
    const expiresAt = new Date(Date.now() + 60_000)
    await adapter.create({ model: 'verification', data: { identifier: 'otp', value: '1', expiresAt } })
    await adapter.create({ model: 'verification', data: { identifier: 'otp', value: '2', expiresAt } })
    const where = [{ field: 'identifier', value: 'otp' }]
    const first = await traced(() => adapter.consumeOne<{ value: string }>({ model: 'verification', where }))
    expect(first.statements).toHaveLength(1)
    expect(first.statements[0]).toMatch(/^DELETE .* RETURNING \*$/)
    const second = await adapter.consumeOne<{ value: string }>({ model: 'verification', where })
    expect([first.result?.value, second?.value].sort()).toEqual(['1', '2'])
    expect(await adapter.consumeOne({ model: 'verification', where })).toBeNull()
    await dispose()
  })

  it('incrementOne updates one row in a single statement and respects the guard', async () => {
    const options: BetterAuthOptions = { rateLimit: { enabled: true, storage: 'database' } }
    const { adapter, traced, dispose } = await recorded(options)
    await adapter.create({ model: 'rateLimit', data: { key: 'ip', count: 1, lastRequest: 1 } })
    const bumped = await traced(() =>
      adapter.incrementOne<{ count: number; lastRequest: number }>({
        model: 'rateLimit',
        where: [{ field: 'key', value: 'ip' }],
        increment: { count: 2 },
        set: { lastRequest: 5 },
      }),
    )
    expect(bumped.statements).toHaveLength(1)
    expect(bumped.result).toMatchObject({ count: 3, lastRequest: 5 })
    const missed = await adapter.incrementOne({
      model: 'rateLimit',
      where: [
        { field: 'key', value: 'ip' },
        { field: 'count', value: 1 },
      ],
      increment: { count: 1 },
    })
    expect(missed).toBeNull()
    await dispose()
  })

  it('resolves joins with one query per joined table instead of one per row', async () => {
    const { adapter, traced, dispose } = await recorded({ advanced: { database: { joins: true } } })
    const users = await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        adapter.create<{ id: string }>({ model: 'user', data: { name, email: `${name}@example.com` } }),
      ),
    )
    await Promise.all(
      users.flatMap((user) =>
        [1, 2].map((n) =>
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
      ),
    )
    const found = await traced(() =>
      adapter.findMany<{ session: ReadonlyArray<unknown> }>({ model: 'user', join: { session: true } }),
    )
    expect(found.statements).toHaveLength(2)
    expect(found.result.map((user) => user.session.length)).toEqual([2, 2, 2])
    await dispose()
  })
})
