/**
 * Runs under Bun (`pnpm test:bun`), where Vitest's harness doesn't: the README promises Bun, and
 * the app-transaction bridge relies on Bun's AsyncLocalStorage. Fails the process on any check.
 */
import { SqliteClient } from '@effect/sql-sqlite-bun'
import type { BetterAuthOptions } from 'better-auth'
import { Array, Data, DateTime, Effect, Layer, String } from 'effect'
import { SqlClient } from 'effect/sql'
import { AuthCallError, EffectSqlAdapter } from '../src/index'
import { Auth, authOptions, signUpBody } from './auth'

class SmokeFailure extends Data.TaggedError('SmokeFailure')<{ readonly check: string }> {}

const check = (name: string, passed: boolean) => (passed ? Effect.void : Effect.fail(new SmokeFailure({ check: name })))

/** With the rate limit table, which `incrementOne` writes to. */
const schemaOptions: BetterAuthOptions = { ...authOptions, rateLimit: { enabled: true, storage: 'database' } }

const createSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const adapter = (yield* EffectSqlAdapter.make())(schemaOptions)
  const schema = yield* Effect.promise(
    () => adapter.createSchema?.(schemaOptions, undefined) ?? Promise.resolve(undefined),
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

/** Every adapter method once: a driver may shape its results unlike `node:sqlite`'s. */
const adapterMethods = Effect.gen(function* () {
  const adapter = (yield* EffectSqlAdapter.make())(schemaOptions)
  const expiresAt = DateTime.toDateUtc(DateTime.add(yield* DateTime.now, { minutes: 1 }))
  const otp = [{ field: 'identifier', value: 'otp' }]
  yield* Effect.forEach(
    ['1', '2', '3'],
    (value) =>
      Effect.promise(() => adapter.create({ model: 'verification', data: { identifier: 'otp', value, expiresAt } })),
    { discard: true },
  )
  const found = yield* Effect.promise(() => adapter.findOne<{ value: string }>({ model: 'verification', where: otp }))
  yield* check('findOne', found !== null)
  yield* check('findMany', (yield* Effect.promise(() => adapter.findMany({ model: 'verification' }))).length === 3)
  yield* check('count', (yield* Effect.promise(() => adapter.count({ model: 'verification', where: otp }))) === 3)
  const updated = yield* Effect.promise(() =>
    adapter.update<{ value: string }>({ model: 'verification', where: otp, update: { value: '0' } }),
  )
  yield* check('update', updated?.value === '0')
  const updatedMany = yield* Effect.promise(() =>
    adapter.updateMany({ model: 'verification', where: otp, update: { value: 'x' } }),
  )
  yield* check('updateMany counts the rows it wrote', updatedMany === 3)
  const consumed = yield* Effect.promise(() => adapter.consumeOne({ model: 'verification', where: otp }))
  yield* check('consumeOne', consumed !== null)
  const left = yield* Effect.flatMap(
    Effect.promise(() => adapter.findOne<{ id: string }>({ model: 'verification', where: otp })),
    (row) => Effect.mapError(Effect.fromNullishOr(row), () => new SmokeFailure({ check: 'findOne after consumeOne' })),
  )
  yield* Effect.promise(() => adapter.delete({ model: 'verification', where: [{ field: 'id', value: left.id }] }))
  const deletedMany = yield* Effect.promise(() => adapter.deleteMany({ model: 'verification', where: [] }))
  yield* check('deleteMany counts the rows it deleted', deletedMany === 1)
  yield* Effect.promise(() => adapter.create({ model: 'rateLimit', data: { key: 'ip', count: 1, lastRequest: 1 } }))
  const bumped = yield* Effect.promise(() =>
    adapter.incrementOne<{ count: number }>({
      model: 'rateLimit',
      where: [{ field: 'key', value: 'ip' }],
      increment: { count: 1 },
    }),
  )
  yield* check('incrementOne', bumped?.count === 2)
})

const smoke = Effect.gen(function* () {
  yield* createSchema
  yield* adapterMethods
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
