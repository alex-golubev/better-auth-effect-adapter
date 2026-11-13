/**
 * The adapter runs on the app's SqlClient, so auth traffic shares the app's pool instead of
 * opening connections of its own. With a pool of one connection, concurrent app queries and
 * auth calls (whose transactions reserve that connection) must neither deadlock nor make
 * PostgreSQL see a second client connection.
 */
import { expect } from '@effect/vitest'
import { Array as Arr, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { bind } from '../src/adapter'
import { Auth, authOptions, signUpBody } from './auth'
import { postgresDatabase, resetSchema, withDatabase } from './harness'

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

withDatabase(Layer.provideMerge(Auth.layer, postgresDatabase({ maxConnections: 1 })))(
  'one pool for the app and auth (PostgreSQL)',
  (it) => {
    it.effect('runs concurrent app and auth work on the app pool alone', () =>
      Effect.gen(function* () {
        yield* resetSchema(authOptions)
        const auth = bind(yield* Auth)
        const signUp = (n: number) => auth.use((api) => api.signUpEmail({ body: signUpBody(`pool-${n}@example.com`) }))
        yield* Effect.all(
          [
            Effect.forEach(Arr.range(1, 10), () => appQuery, { concurrency: 'unbounded' }),
            Effect.forEach(Arr.range(1, 10), signUp, { concurrency: 'unbounded' }),
          ],
          { concurrency: 'unbounded' },
        ).pipe(Effect.timeout('20 seconds'))
        expect(yield* clientConnections).toBe(1)
      }),
    )
  },
)
