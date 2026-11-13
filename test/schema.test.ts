import { describe, expect } from '@effect/vitest'
import type { BetterAuthOptions } from 'better-auth'
import { organization } from 'better-auth/plugins'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { dialectProfiles } from '../src/dialect'
import type { IdStrategy } from '../src/schema'
import { toSqlValue } from '../src/where'
import {
  type Database,
  dialectOf,
  mysqlDatabase,
  postgresDatabase,
  resetSchema,
  sqliteDatabase,
  withDatabase,
} from './harness'

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

const expectIdShape: Record<IdStrategy, (id: unknown) => void> = {
  string: (id) => expect(id).toBe('user-1'),
  serial: (id) => expect(Number(id)).toBeGreaterThan(0),
  uuid: (id) => expect(String(id)).toMatch(/^[0-9a-f-]{36}$/),
}

// Each test recreates the tables with another id type on the same pool (see `preparedStatements`).
const databases: ReadonlyArray<readonly [string, Database]> = [
  ['sqlite', sqliteDatabase()],
  ['pg', postgresDatabase({ preparedStatements: false })],
  ['mysql', mysqlDatabase({ preparedStatements: false })],
]

describe.each(databases)('generated schema on %s', (_, database) => {
  withDatabase(database)((it) => {
    it.effect.each(strategies)('creates the kitchen-sink schema with %s ids, twice', (idStrategy) =>
      Effect.andThen(resetSchema(kitchenSink(idStrategy)), resetSchema(kitchenSink(idStrategy))),
    )

    it.effect.each(strategies)('enforces foreign keys with ON DELETE CASCADE and id defaults (%s ids)', (idStrategy) =>
      Effect.gen(function* () {
        yield* resetSchema({ advanced: generateId(idStrategy) })
        const sql = yield* SqlClient.SqlClient
        const dialect = yield* dialectOf
        const now = toSqlValue(dialectProfiles[dialect])(new Date())
        // Who generates the id: the app for string ids (and uuid outside PostgreSQL), the database otherwise.
        const appId = (value: string) =>
          idStrategy === 'string'
            ? { id: value }
            : idStrategy === 'uuid' && dialect !== 'pg'
              ? { id: crypto.randomUUID() }
              : {}
        const email = `${idStrategy}@example.com`
        yield* sql`INSERT INTO ${sql('user')} ${sql.insert({
          ...appId('user-1'),
          name: 'Alice',
          email,
          emailVerified: toSqlValue(dialectProfiles[dialect])(false),
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
        expect(Number(sessions?.n)).toBe(0)
        expectIdShape[idStrategy](user?.id)
      }),
    )
  })
})
