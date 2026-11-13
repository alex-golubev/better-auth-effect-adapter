/**
 * The adapter runs on the app's SqlClient, so auth traffic shares the app's pool instead of
 * opening connections of its own. With a pool of one connection, concurrent app queries and
 * auth calls (whose transactions reserve that connection) must neither deadlock nor make
 * PostgreSQL see a second client connection.
 */
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { Array as Arr, Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fromContext, run } from '../src/adapter'
import { postgresDatabase } from './harness'

const options = {
  baseURL: 'http://localhost:3000',
  secret: 'shared-pool-secret-that-is-long-enough-for-better-auth',
  emailAndPassword: { enabled: true },
  logger: { disabled: true },
  telemetry: { enabled: false },
} satisfies BetterAuthOptions

const appQuery = Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT pg_sleep(0.02)`)

const clientConnections = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql<{ n: unknown }>`
      SELECT COUNT(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
    `,
    ([row]) => Number(row?.n),
  ),
)

const db = await postgresDatabase({ maxConnections: 1 })

afterAll(() => db.dispose())

describe('one pool for the app and auth (PostgreSQL)', () => {
  beforeAll(() => db.resetSchema(options))

  it('runs concurrent app and auth work on the app pool alone', async () => {
    const auth = betterAuth({ ...options, database: fromContext(db.context) })
    const signUp = (n: number) =>
      run(() =>
        auth.api.signUpEmail({ body: { email: `pool-${n}@example.com`, password: 'password1234', name: 'Pool' } }),
      )
    const connections = await db.run(
      Effect.timeout(
        Effect.andThen(
          Effect.all(
            [
              Effect.forEach(Arr.range(1, 10), () => appQuery, { concurrency: 'unbounded' }),
              Effect.forEach(Arr.range(1, 10), signUp, { concurrency: 'unbounded' }),
            ],
            { concurrency: 'unbounded' },
          ),
          clientConnections,
        ),
        '20 seconds',
      ),
    )
    expect(connections).toBe(1)
  })
})
