import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, Effect, ManagedRuntime } from 'effect'
import { SqlClient, SqlError } from 'effect/sql'
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
