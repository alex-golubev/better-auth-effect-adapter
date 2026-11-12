import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, Effect, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/sql'
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
