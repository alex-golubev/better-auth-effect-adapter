import type { BetterAuthOptions } from 'better-auth'
import { organization } from 'better-auth/plugins'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IdStrategy } from '../src/schema'
import { mysqlDatabase, postgresDatabase, sqliteDatabase, type TestDatabase } from './harness'

const generateId = (idStrategy: IdStrategy): BetterAuthOptions['advanced'] =>
  idStrategy === 'string' ? {} : { database: { generateId: idStrategy } }

/** Covers the schema shapes the official adapter test suites migrate to. */
const kitchenSink = (idStrategy: IdStrategy): BetterAuthOptions => ({
  advanced: generateId(idStrategy),
  user: {
    modelName: 'user_custom',
    fields: { email: 'email_address' },
    additionalFields: {
      customField: { type: 'string', required: false },
      numericField: { type: 'number', required: false },
      dateField: { type: 'date', required: false },
    },
  },
  plugins: [
    organization({ teams: { enabled: true } }),
    {
      id: 'test-models',
      schema: {
        testModel: {
          fields: {
            nullableReference: { type: 'string', required: false, references: { model: 'user', field: 'id' } },
            stringArray: { type: 'string[]', required: false },
            numberArray: { type: 'number[]', required: false },
            json: { type: 'json', required: false },
            tenant: { type: 'string' },
            slug: { type: 'string' },
          },
          indexes: [{ fields: ['tenant', 'slug'], unique: true }],
        },
        oneToOneTable: {
          modelName: 'one_to_one_table',
          fields: {
            oneToOne: {
              type: 'string',
              required: true,
              unique: true,
              fieldName: 'one_to_one',
              references: { model: 'user', field: 'email' },
            },
          },
        },
      },
    },
  ],
})

const strategies: ReadonlyArray<IdStrategy> = ['string', 'serial', 'uuid']

describe.each([
  ['sqlite', sqliteDatabase],
  ['pg', postgresDatabase],
  ['mysql', mysqlDatabase],
] as const)('generated schema on %s', (_, connect) => {
  let db: TestDatabase

  beforeAll(async () => {
    db = await connect()
  })

  afterAll(async () => {
    await db?.dispose()
  })

  it.each(strategies)('creates the kitchen-sink schema with %s ids, twice', async (idStrategy) => {
    await db.resetSchema(kitchenSink(idStrategy))
    await db.resetSchema(kitchenSink(idStrategy))
  })

  it.each(strategies)('enforces foreign keys with ON DELETE CASCADE and id defaults (%s ids)', async (idStrategy) => {
    await db.resetSchema({ advanced: generateId(idStrategy) })
    const { dialect } = db
    const now = dialect === 'sqlite' ? new Date().toISOString() : new Date()
    // Who generates the id: the app for string ids (and uuid outside PostgreSQL), the database otherwise.
    const appId = (value: string) =>
      idStrategy === 'string'
        ? { id: value }
        : idStrategy === 'uuid' && dialect !== 'pg'
          ? { id: crypto.randomUUID() }
          : {}

    const result = await db.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const email = `${idStrategy}@example.com`
        yield* sql`INSERT INTO ${sql('user')} ${sql.insert({
          ...appId('user-1'),
          name: 'Alice',
          email,
          emailVerified: dialect === 'sqlite' ? 0 : false,
          createdAt: now,
          updatedAt: now,
        })}`
        const [user] = yield* sql<{
          id: unknown
        }>`SELECT ${sql('id')} FROM ${sql('user')} WHERE ${sql('email')} = ${email}`
        yield* sql`INSERT INTO ${sql('session')} ${sql.insert({
          ...appId('session-1'),
          expiresAt: now,
          token: `token-${idStrategy}`,
          createdAt: now,
          updatedAt: now,
          userId: user?.id as string,
        })}`
        yield* sql`DELETE FROM ${sql('user')} WHERE ${sql('id')} = ${user?.id as string}`
        const [sessions] = yield* sql<{ n: unknown }>`SELECT COUNT(*) AS ${sql('n')} FROM ${sql('session')}`
        return { userId: user?.id, sessions: Number(sessions?.n) }
      }),
    )

    expect(result.sessions).toBe(0)
    if (idStrategy === 'serial') expect(Number(result.userId)).toBeGreaterThan(0)
    if (idStrategy === 'uuid') expect(String(result.userId)).toMatch(/^[0-9a-f-]{36}$/)
  })
})
