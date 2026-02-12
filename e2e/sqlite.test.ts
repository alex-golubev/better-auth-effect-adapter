import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { Effect, ManagedRuntime } from 'effect'
import { SqlClient } from '@effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { runAdapterTest } from 'better-auth/adapters/test'
import { effectSqlAdapter } from '../src'

describe('effectSqlAdapter - SQLite', () => {
  const SqliteLive = SqliteClient.layer({ filename: ':memory:' })
  const runtime = ManagedRuntime.make(SqliteLive)

  beforeAll(async () => {
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          sql`
            CREATE TABLE IF NOT EXISTS user (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              email TEXT UNIQUE,
              email_address TEXT,
              emailVerified INTEGER NOT NULL DEFAULT 0,
              image TEXT,
              createdAt TEXT NOT NULL,
              updatedAt TEXT NOT NULL
            )
          `,
          sql`
            CREATE TABLE IF NOT EXISTS session (
              id TEXT PRIMARY KEY,
              expiresAt TEXT NOT NULL,
              token TEXT NOT NULL UNIQUE,
              createdAt TEXT NOT NULL,
              updatedAt TEXT NOT NULL,
              ipAddress TEXT,
              userAgent TEXT,
              userId TEXT NOT NULL,
              FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
            )
          `,
          sql`
            CREATE TABLE IF NOT EXISTS account (
              id TEXT PRIMARY KEY,
              accountId TEXT NOT NULL,
              providerId TEXT NOT NULL,
              userId TEXT NOT NULL,
              accessToken TEXT,
              refreshToken TEXT,
              idToken TEXT,
              accessTokenExpiresAt TEXT,
              refreshTokenExpiresAt TEXT,
              scope TEXT,
              password TEXT,
              createdAt TEXT NOT NULL,
              updatedAt TEXT NOT NULL,
              FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
            )
          `,
          sql`
            CREATE TABLE IF NOT EXISTS verification (
              id TEXT PRIMARY KEY,
              identifier TEXT NOT NULL,
              value TEXT NOT NULL,
              expiresAt TEXT NOT NULL,
              createdAt TEXT NOT NULL,
              updatedAt TEXT
            )
          `,
        ]),
      ),
    )
  })

  afterAll(async () => {
    await runtime.dispose()
  })

  const factory = effectSqlAdapter({ runtime, dialect: 'sqlite' })

  runAdapterTest({
    getAdapter: async (customOptions) => factory(customOptions ?? {}),
    testPrefix: 'SQLite',
  })

  it('SQLite - should handle IN filters with boolean array values', async () => {
    const adapter = factory({})
    const now = new Date()
    const testId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const trueEmail = `${testId}-true@example.com`
    const falseEmail = `${testId}-false@example.com`

    await adapter.create({
      model: 'user',
      data: {
        name: 'bool-user-true',
        email: trueEmail,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    })

    await adapter.create({
      model: 'user',
      data: {
        name: 'bool-user-false',
        email: falseEmail,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    })

    const results = await adapter.findMany<{ email: string }>({
      model: 'user',
      where: [{ field: 'emailVerified', operator: 'in', value: [true] as unknown as number[], connector: 'AND' }],
      limit: 20,
    })

    expect(results.some((row) => row.email === trueEmail)).toBe(true)
    expect(results.some((row) => row.email === falseEmail)).toBe(false)
  })

  it('SQLite - should handle IN filters with date array values', async () => {
    const adapter = factory({})
    const targetCreatedAt = new Date('2026-02-12T10:00:00.000Z')
    const targetUpdatedAt = new Date('2026-02-12T11:00:00.000Z')
    const testEmail = `${Date.now()}-date-in@example.com`

    await adapter.create({
      model: 'user',
      data: {
        name: 'date-user',
        email: testEmail,
        emailVerified: true,
        createdAt: targetCreatedAt,
        updatedAt: targetUpdatedAt,
      },
    })

    const results = await adapter.findMany<{ email: string }>({
      model: 'user',
      where: [{ field: 'createdAt', operator: 'in', value: [targetCreatedAt] as unknown as string[], connector: 'AND' }],
      limit: 20,
    })

    expect(results.some((row) => row.email === testEmail)).toBe(true)
  })
})
