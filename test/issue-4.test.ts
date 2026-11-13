/**
 * GitHub issue #4: better-auth calls inside an app's `sql.withTransaction` froze on SQLite
 * (the adapter waited for the connection the transaction held) and escaped the transaction
 * on pooled databases. `EffectSqlAdapter.run` / `bind` carry the transaction to the adapter.
 * On PostgreSQL and MySQL the rollback tests are the ones that catch the escape.
 */
import { SqliteClient } from '@effect/sql-sqlite-node'
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { Effect, Exit, ManagedRuntime } from 'effect'
import { SqlClient } from 'effect/sql'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { bind, fromContext, run } from '../src/adapter'
import { type Dialect, dialectProfiles } from '../src/dialect'
import { toSqlValue } from '../src/where'
import { mysqlDatabase, postgresDatabase, sqliteDatabase, type TestDatabase } from './harness'

const options = {
  baseURL: 'http://localhost:3000',
  secret: 'issue-4-secret-that-is-long-enough-for-better-auth',
  emailAndPassword: { enabled: true },
  logger: { disabled: true },
  telemetry: { enabled: false },
} satisfies BetterAuthOptions

const makeAuth = (db: TestDatabase) => betterAuth({ ...options, database: fromContext(db.context) })

const signUpBody = (email: string) => ({ email, password: 'password1234', name: 'Issue Four' })

const rowsIn = (table: string, where: { readonly column: string; readonly value: string }) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)} WHERE ${sql(where.column)} = ${where.value}`,
      ([row]) => Number(row?.n),
    ),
  )

const appWrite = (dialect: Dialect, identifier: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const now = toSqlValue(dialectProfiles[dialect])(new Date())
    return sql`INSERT INTO ${sql('verification')} ${sql.insert({
      id: identifier,
      identifier,
      value: 'app',
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
    })}`
  })

const databases: ReadonlyArray<TestDatabase> = await Promise.all([
  sqliteDatabase(),
  postgresDatabase(),
  mysqlDatabase(),
])

afterAll(() => Promise.all(databases.map((db) => db.dispose())))

describe.each(databases)('issue #4: auth calls inside an app transaction ($dialect)', (db) => {
  const auth = makeAuth(db)

  beforeEach(() => db.resetSchema(options))

  /** Fails fast instead of hanging if the deadlock ever comes back. */
  const inAppTransaction = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    db.run(
      Effect.exit(
        Effect.timeout(
          Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(body)),
          '5 seconds',
        ),
      ),
    )

  it('commits auth writes together with the app transaction', async () => {
    const email = 'commit@example.com'
    const exit = await inAppTransaction(
      Effect.gen(function* () {
        yield* appWrite(db.dialect, 'app-commit')
        yield* run(() => auth.api.signUpEmail({ body: signUpBody(email) }))
        return yield* rowsIn('user', { column: 'email', value: email })
      }),
    )
    expect(exit).toEqual(Exit.succeed(1))
    expect(await db.run(rowsIn('user', { column: 'email', value: email }))).toBe(1)
    expect(await db.run(rowsIn('verification', { column: 'id', value: 'app-commit' }))).toBe(1)
  })

  it('rolls auth writes back together with the app transaction', async () => {
    const email = 'rollback@example.com'
    const exit = await inAppTransaction(
      Effect.gen(function* () {
        yield* appWrite(db.dialect, 'app-rollback')
        const { user } = yield* run(() => auth.api.signUpEmail({ body: signUpBody(email) }))
        return yield* Effect.fail({ reason: 'app failure', userId: user.id })
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await db.run(rowsIn('user', { column: 'email', value: email }))).toBe(0)
    expect(await db.run(rowsIn('verification', { column: 'id', value: 'app-rollback' }))).toBe(0)
  })

  it('carries the transaction through bind(auth).use and bind(auth).handler', async () => {
    const bound = bind(auth)
    const exit = await inAppTransaction(
      Effect.gen(function* () {
        yield* bound.use((api) => api.signUpEmail({ body: signUpBody('use@example.com') }))
        const response = yield* bound.handler(
          new Request('http://localhost:3000/api/auth/sign-up/email', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(signUpBody('handler@example.com')),
          }),
        )
        const visible = yield* rowsIn('user', { column: 'email', value: 'handler@example.com' })
        return yield* Effect.fail({ status: response.status, visible })
      }),
    )
    expect(exit).toEqual(Exit.fail({ status: 200, visible: 1 }))
    expect(await db.run(rowsIn('user', { column: 'email', value: 'use@example.com' }))).toBe(0)
    expect(await db.run(rowsIn('user', { column: 'email', value: 'handler@example.com' }))).toBe(0)
  })

  it('ignores a bridged context backed by another SqlClient', async () => {
    // Another database, without the auth tables: auth queries must not end up there.
    const other = ManagedRuntime.make(SqliteClient.layer({ filename: ':memory:' }))
    await other.runPromise(run(() => auth.api.signUpEmail({ body: signUpBody('other@example.com') })))
    await other.dispose()
    expect(await db.run(rowsIn('user', { column: 'email', value: 'other@example.com' }))).toBe(1)
  })
})
