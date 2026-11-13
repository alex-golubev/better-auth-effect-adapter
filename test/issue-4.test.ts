/**
 * GitHub issue #4: better-auth calls inside an app's `sql.withTransaction` froze on SQLite
 * (the adapter waited for the connection the transaction held) and escaped the transaction
 * on pooled databases. `EffectSqlAdapter.run` / `bind` carry the transaction to the adapter.
 * On PostgreSQL and MySQL the rollback tests are the ones that catch the escape.
 */
import { SqliteClient } from '@effect/sql-sqlite-node'
import { describe, expect } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { bind, run } from '../src/adapter'
import { dialectProfiles } from '../src/dialect'
import { toSqlValue } from '../src/where'
import { Auth, authOptions, signUpBody } from './auth'
import {
  type Database,
  dialectOf,
  mysqlDatabase,
  postgresDatabase,
  resetSchema,
  sqliteDatabase,
  withDatabase,
} from './harness'

const rowsIn = (table: string, where: { readonly column: string; readonly value: string }) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)} WHERE ${sql(where.column)} = ${where.value}`,
      ([row]) => Number(row?.n),
    ),
  )

const usersWith = (email: string) => rowsIn('user', { column: 'email', value: email })

/** A write of the app's own, next to auth's. */
const appWrite = (identifier: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = toSqlValue(dialectProfiles[yield* dialectOf])(new Date())
    yield* sql`INSERT INTO ${sql('verification')} ${sql.insert({
      id: identifier,
      identifier,
      value: 'app',
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
    })}`
  })

/** Runs `body` in an app transaction; fails fast instead of hanging if the deadlock ever comes back. */
const inAppTransaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.exit(
    Effect.timeout(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(body)),
      '5 seconds',
    ),
  )

const databases: ReadonlyArray<readonly [string, Database]> = [
  ['sqlite', sqliteDatabase()],
  ['pg', postgresDatabase()],
  ['mysql', mysqlDatabase()],
]

describe.each(databases)('issue #4: auth calls inside an app transaction (%s)', (_, database) => {
  withDatabase(Layer.provideMerge(Auth.layer, database))((it) => {
    it.effect('commits auth writes together with the app transaction', () =>
      Effect.gen(function* () {
        yield* resetSchema(authOptions)
        const auth = yield* Auth
        const email = 'commit@example.com'
        const exit = yield* inAppTransaction(
          Effect.gen(function* () {
            yield* appWrite('app-commit')
            yield* run(() => auth.api.signUpEmail({ body: signUpBody(email) }))
            return yield* usersWith(email)
          }),
        )
        expect(exit).toEqual(Exit.succeed(1))
        expect(yield* usersWith(email)).toBe(1)
        expect(yield* rowsIn('verification', { column: 'id', value: 'app-commit' })).toBe(1)
      }),
    )

    it.effect('rolls auth writes back together with the app transaction', () =>
      Effect.gen(function* () {
        yield* resetSchema(authOptions)
        const auth = yield* Auth
        const email = 'rollback@example.com'
        const exit = yield* inAppTransaction(
          Effect.gen(function* () {
            yield* appWrite('app-rollback')
            const { user } = yield* run(() => auth.api.signUpEmail({ body: signUpBody(email) }))
            return yield* Effect.fail({ reason: 'app failure', userId: user.id })
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* usersWith(email)).toBe(0)
        expect(yield* rowsIn('verification', { column: 'id', value: 'app-rollback' })).toBe(0)
      }),
    )

    it.effect('carries the transaction through bind(auth).use and bind(auth).handler', () =>
      Effect.gen(function* () {
        yield* resetSchema(authOptions)
        const bound = bind(yield* Auth)
        const exit = yield* inAppTransaction(
          Effect.gen(function* () {
            yield* bound.use((api) => api.signUpEmail({ body: signUpBody('use@example.com') }))
            const response = yield* bound.handler(
              new Request('http://localhost:3000/api/auth/sign-up/email', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(signUpBody('handler@example.com')),
              }),
            )
            const visible = yield* usersWith('handler@example.com')
            return yield* Effect.fail({ status: response.status, visible })
          }),
        )
        expect(exit).toEqual(Exit.fail({ status: 200, visible: 1 }))
        expect(yield* usersWith('use@example.com')).toBe(0)
        expect(yield* usersWith('handler@example.com')).toBe(0)
      }),
    )

    it.effect('ignores a bridged context backed by another SqlClient', () =>
      Effect.gen(function* () {
        yield* resetSchema(authOptions)
        const auth = yield* Auth
        // Another database, without the auth tables: auth queries must not end up there.
        yield* run(() => auth.api.signUpEmail({ body: signUpBody('other@example.com') })).pipe(
          Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
        )
        expect(yield* usersWith('other@example.com')).toBe(1)
      }),
    )
  })
})
