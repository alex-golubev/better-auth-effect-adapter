/**
 * Runs under Bun (`pnpm test:bun`), where Vitest's harness doesn't: the README promises Bun, and
 * the app-transaction bridge relies on Bun's AsyncLocalStorage. Fails the process on any check.
 */
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { Array, Data, Effect, Layer, String } from 'effect'
import { SqlClient } from 'effect/sql'
import { AuthCallError, EffectSqlAdapter } from '../src/index'
import { Auth, authOptions, signUpBody } from './auth'

class SmokeFailure extends Data.TaggedError('SmokeFailure')<{ readonly check: string }> {}

const check = (name: string, passed: boolean) => (passed ? Effect.void : Effect.fail(new SmokeFailure({ check: name })))

const createSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const adapter = (yield* EffectSqlAdapter.make())(authOptions)
  const schema = yield* Effect.promise(
    () => adapter.createSchema?.(authOptions, undefined) ?? Promise.resolve(undefined),
  )
  const statements = Array.filter(String.split(schema?.code ?? '', ';'), (statement) =>
    String.isNonEmpty(String.trim(statement)),
  )
  yield* Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true })
})

const usersWith = (email: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(sql<{ n: number }>`SELECT COUNT(*) AS n FROM "user" WHERE email = ${email}`, ([row]) => Number(row?.n)),
  )

const inAppTransaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.exit(
    Effect.timeout(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(body)),
      '5 seconds',
    ),
  )

const smoke = Effect.gen(function* () {
  yield* createSchema
  const auth = EffectSqlAdapter.bind(yield* Auth)

  const committed = yield* inAppTransaction(
    auth.use((api) => api.signUpEmail({ body: signUpBody('commit@example.com') })),
  )
  yield* check('commits with the app transaction', committed._tag === 'Success')
  yield* check('the committed user exists', (yield* usersWith('commit@example.com')) === 1)

  const rolledBack = yield* inAppTransaction(
    Effect.andThen(
      auth.use((api) => api.signUpEmail({ body: signUpBody('rollback@example.com') })),
      Effect.fail('app failure'),
    ),
  )
  yield* check('rolls back with the app transaction', rolledBack._tag === 'Failure')
  yield* check('the rolled-back user is gone', (yield* usersWith('rollback@example.com')) === 0)

  const rejected = yield* Effect.flip(
    auth.use((api) => api.signInEmail({ body: { email: 'commit@example.com', password: 'wrong-password' } })),
  )
  yield* check('a rejected call fails with AuthCallError', rejected instanceof AuthCallError)
})

const database = Layer.provideMerge(Auth.layer, SqliteClient.layer({ filename: ':memory:' }))

await Effect.runPromise(
  Effect.scoped(Effect.flatMap(Layer.build(database), (context) => Effect.provideContext(smoke, context))),
)
