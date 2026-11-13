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

describe.each(databases)('operations under concurrency (%s)', (_, database) => {
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
