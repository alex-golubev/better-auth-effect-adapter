/**
 * A model name such as `auth.user` names a table in another schema: an attached database on SQLite,
 * another database on MySQL. The generated schema has to create the tables the queries then use.
 */
import { describe, expect } from '@effect/vitest'
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { Array, Effect, String } from 'effect'
import { SqlClient } from 'effect/sql'
import { make } from '../src/adapter'
import { type Dialect, dialectOf } from '../src/dialect'
import { authOptions, signUpBody } from './auth'
import { type Database, mysqlDatabase, postgresDatabase, sqliteDatabase, withDatabase } from './harness'

const options = {
  ...authOptions,
  user: { modelName: 'auth.user' },
  session: { modelName: 'auth.session' },
  account: { modelName: 'auth.account' },
  verification: { modelName: 'auth.verification' },
  advanced: { database: { joins: true } },
} satisfies BetterAuthOptions

const createAuthSchema: Record<Dialect, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  sqlite: Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ATTACH DATABASE ':memory:' AS auth`),
  pg: Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE SCHEMA auth`),
  mysql: Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE DATABASE auth`),
}

const statementsOf = (code: string) =>
  Array.filter(String.split(code, ';'), (statement) => String.isNonEmpty(String.trim(statement)))

const databases: ReadonlyArray<readonly [string, Database]> = [
  ['sqlite', sqliteDatabase()],
  ['pg', postgresDatabase()],
  ['mysql', mysqlDatabase({ root: true })],
]

describe.each(databases)('schema-qualified model names (%s)', (_, database) => {
  withDatabase(database)((it) => {
    it.effect('creates the tables that sign-up, joins and bulk writes then use', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* createAuthSchema[yield* dialectOf]
        const factory = yield* make()
        const adapter = factory(options)
        const schema = yield* Effect.promise(
          () => adapter.createSchema?.(options, undefined) ?? Promise.resolve(undefined),
        )
        yield* Effect.forEach(statementsOf(schema?.code ?? ''), (statement) => sql.unsafe(statement), {
          discard: true,
        })

        const auth = betterAuth({ ...options, database: factory })
        const { user } = yield* Effect.promise(() =>
          auth.api.signUpEmail({ body: signUpBody('qualified@example.com') }),
        )
        yield* Effect.promise(() =>
          auth.api.signInEmail({ body: { email: 'qualified@example.com', password: 'password1234' } }),
        )

        const [stored] = yield* sql<{ n: unknown }>`SELECT COUNT(*) AS ${sql('n')} FROM ${sql('auth.user')}`
        expect(Number(stored?.n)).toBe(1)
        const sessions = yield* Effect.promise(() =>
          adapter.findMany<{ user: { email: string } }>({ model: 'session', join: { user: true } }),
        )
        expect(Array.map(sessions, (session) => session.user.email)).toEqual([
          'qualified@example.com',
          'qualified@example.com',
        ])
        const users = yield* Effect.promise(() =>
          adapter.findMany<{ session: ReadonlyArray<unknown> }>({ model: 'user', join: { session: true } }),
        )
        expect(Array.map(users, (found) => found.session.length)).toEqual([2])
        const byUser = [{ field: 'userId', value: user.id }]
        expect(
          yield* Effect.promise(() =>
            adapter.updateMany({ model: 'session', where: byUser, update: { ipAddress: '127.0.0.1' } }),
          ),
        ).toBe(2)
        expect(yield* Effect.promise(() => adapter.deleteMany({ model: 'session', where: byUser }))).toBe(2)
      }),
    )
  })
})
