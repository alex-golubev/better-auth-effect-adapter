/**
 * Guards must hold under concurrency: Better Auth's database rate limiter relies on `incrementOne`
 * refusing a row that a concurrent request has just changed. The first call holds its row lock
 * in a transaction while the second one waits on it.
 */
import { describe, expect } from '@effect/vitest'
import type { BetterAuthOptions } from 'better-auth'
import { DateTime, Deferred, Effect, Fiber } from 'effect'
import { SqlClient } from 'effect/sql'
import { make, run } from '../src/adapter'
import { type Database, mysqlDatabase, postgresDatabase, resetSchema, sqliteDatabase, withDatabase } from './harness'

const options: BetterAuthOptions = { rateLimit: { enabled: true, storage: 'database' } }

/** A nullable counter, like two-factor's `failedVerificationCount` on rows that predate it. */
const counterOptions: BetterAuthOptions = {
  plugins: [
    {
      id: 'counter',
      schema: { counter: { fields: { name: { type: 'string' }, hits: { type: 'number', required: false } } } },
    },
  ],
}

/** Ids come from the database: on MySQL, from a default that isn't AUTO_INCREMENT. */
const databaseIdOptions: BetterAuthOptions = { ...counterOptions, advanced: { database: { generateId: false } } }

/** Runs `first` in a transaction held open while `second` runs, and returns what `second` got. */
const whileLocked = <A, B>(first: () => Promise<A>, second: () => Promise<B>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const locked = yield* Deferred.make<void>()
    const holder = yield* Effect.forkChild(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* run(first)
          yield* Deferred.succeed(locked, undefined)
          yield* Effect.sleep('300 millis')
        }),
      ),
    )
    yield* Deferred.await(locked)
    const result = yield* run(second)
    yield* Fiber.join(holder)
    return result
  })

const databases: ReadonlyArray<readonly [string, Database]> = [
  ['sqlite', sqliteDatabase()],
  ['pg', postgresDatabase()],
  ['mysql', mysqlDatabase()],
]

describe.each(databases)('operations (%s)', (name, database) => {
  withDatabase(database)((it) => {
    it.effect('incrementOne re-checks its guard on a row a concurrent call changed', () =>
      Effect.gen(function* () {
        yield* resetSchema(options)
        const adapter = (yield* make())(options)
        yield* Effect.promise(() =>
          adapter.create({ model: 'rateLimit', data: { key: 'ip', count: 1, lastRequest: 1 } }),
        )
        const bump = () =>
          adapter.incrementOne<{ count: number }>({
            model: 'rateLimit',
            where: [
              { field: 'key', value: 'ip' },
              { field: 'count', value: 1 },
            ],
            increment: { count: 1 },
          })
        expect(yield* whileLocked(bump, bump)).toBeNull()
        const after = yield* Effect.promise(() =>
          adapter.findOne<{ count: number }>({ model: 'rateLimit', where: [{ field: 'key', value: 'ip' }] }),
        )
        expect(after?.count).toBe(2)
      }),
    )

    it.effect('consumeOne re-checks its condition on a row a concurrent call changed', () =>
      Effect.gen(function* () {
        yield* resetSchema(options)
        const adapter = (yield* make())(options)
        const expiresAt = DateTime.toDateUtc(DateTime.add(yield* DateTime.now, { minutes: 1 }))
        yield* Effect.promise(() =>
          adapter.create({ model: 'verification', data: { identifier: 'otp', value: '1', expiresAt } }),
        )
        const consumed = yield* whileLocked(
          () =>
            adapter.update({
              model: 'verification',
              where: [{ field: 'identifier', value: 'otp' }],
              update: { identifier: 'used' },
            }),
          () => adapter.consumeOne({ model: 'verification', where: [{ field: 'identifier', value: 'otp' }] }),
        )
        expect(consumed).toBeNull()
        expect(yield* Effect.promise(() => adapter.count({ model: 'verification' }))).toBe(1)
      }),
    )

    // @effect/sql-pg decodes int8 as a JS BigInt.
    it.effect('incrementOne counts a NULL counter as 0', () =>
      Effect.gen(function* () {
        yield* resetSchema(counterOptions)
        const adapter = (yield* make())(counterOptions)
        yield* Effect.promise(() => adapter.create({ model: 'counter', data: { name: 'a' } }))
        const bumped = yield* Effect.promise(() =>
          adapter.incrementOne<{ hits: number | null }>({
            model: 'counter',
            where: [{ field: 'name', value: 'a' }],
            increment: { hits: 1 },
          }),
        )
        expect(bumped?.hits).toBe(1)
      }),
    )

    it.effect.runIf(name === 'mysql')('rolls back an insert whose id it cannot read back', () =>
      Effect.gen(function* () {
        yield* resetSchema(databaseIdOptions)
        const sql = yield* SqlClient.SqlClient
        yield* sql`ALTER TABLE ${sql('counter')} MODIFY ${sql('id')} varchar(36) NOT NULL DEFAULT (UUID())`
        const adapter = (yield* make())(databaseIdOptions)
        const exit = yield* Effect.exit(Effect.promise(() => adapter.create({ model: 'counter', data: { name: 'a' } })))
        expect(exit._tag).toBe('Failure')
        expect(yield* Effect.promise(() => adapter.count({ model: 'counter' }))).toBe(0)
      }),
    )

    it.effect('returns bigint columns as numbers', () =>
      Effect.gen(function* () {
        yield* resetSchema(options)
        const adapter = (yield* make())(options)
        const created = yield* Effect.promise(() =>
          adapter.create<{ key: string; count: number; lastRequest: unknown }>({
            model: 'rateLimit',
            data: { key: 'ip', count: 1, lastRequest: 1_700_000_000_000 },
          }),
        )
        const found = yield* Effect.promise(() =>
          adapter.findOne<{ lastRequest: unknown }>({ model: 'rateLimit', where: [{ field: 'key', value: 'ip' }] }),
        )
        expect(created.lastRequest).toBe(1_700_000_000_000)
        expect(found?.lastRequest).toBe(1_700_000_000_000)
      }),
    )
  })
})
