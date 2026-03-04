import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { Effect, ManagedRuntime } from 'effect'
import { SqlClient } from '@effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { runAdapterTest } from 'better-auth/adapters/test'
import { effectSqlAdapter } from '../src'

describe('effectSqlAdapter - SQLite', () => {
  const SqliteLive = SqliteClient.layer({ filename: ':memory:' })
  const managedRuntime = ManagedRuntime.make(SqliteLive)
  let factory: ReturnType<typeof effectSqlAdapter>

  beforeAll(async () => {
    await managedRuntime.runPromise(
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

    factory = effectSqlAdapter({ runtime: await managedRuntime.runtime(), dialect: 'sqlite' })
  })

  afterAll(async () => {
    await managedRuntime.dispose()
  })

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

  it('SQLite - updateMany should return correct affected row count', async () => {
    const adapter = factory({})
    const now = new Date()
    const marker = `update-count-${Date.now()}`

    for (let i = 0; i < 3; i++) {
      await adapter.create({
        model: 'user',
        data: {
          name: marker,
          email: `${marker}-${i}@test.com`,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      })
    }

    const count = await adapter.updateMany({
      model: 'user',
      where: [{ field: 'name', value: marker, connector: 'AND' }],
      update: { emailVerified: true },
    })

    expect(count).toBe(3)
  })

  it('SQLite - deleteMany should return correct affected row count', async () => {
    const adapter = factory({})
    const now = new Date()
    const marker = `delete-count-${Date.now()}`

    for (let i = 0; i < 3; i++) {
      await adapter.create({
        model: 'user',
        data: {
          name: marker,
          email: `${marker}-${i}@test.com`,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      })
    }

    const count = await adapter.deleteMany({
      model: 'user',
      where: [{ field: 'name', value: marker, connector: 'AND' }],
    })

    expect(count).toBe(3)
  })
})

describe('effectSqlAdapter - SQLite (with identifier transforms)', () => {
  const camelToSnake = (str: string) => str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  const snakeToCamel = (str: string) => str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

  const SqliteLive = SqliteClient.layer({
    filename: ':memory:',
    transformQueryNames: camelToSnake,
    transformResultNames: snakeToCamel,
  })
  const managedRuntime = ManagedRuntime.make(SqliteLive)
  let factory: ReturnType<typeof effectSqlAdapter>

  beforeAll(async () => {
    // Use sql.unsafe for DDL to avoid identifier transforms on column definitions
    await managedRuntime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`
          CREATE TABLE IF NOT EXISTS user (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE,
            email_verified INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `),
      ),
    )

    factory = effectSqlAdapter({ runtime: await managedRuntime.runtime(), dialect: 'sqlite' })
  })

  afterAll(async () => {
    await managedRuntime.dispose()
  })

  it('updateMany should preserve identifier transforms', async () => {
    const adapter = factory({})
    const now = new Date()
    const marker = `transform-update-${Date.now()}`

    for (let i = 0; i < 2; i++) {
      await adapter.create({
        model: 'user',
        data: {
          name: marker,
          email: `${marker}-${i}@test.com`,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      })
    }

    const count = await adapter.updateMany({
      model: 'user',
      where: [{ field: 'name', value: marker, connector: 'AND' }],
      update: { emailVerified: true },
    })

    expect(count).toBe(2)
  })

  it('deleteMany should preserve identifier transforms', async () => {
    const adapter = factory({})
    const now = new Date()
    const marker = `transform-delete-${Date.now()}`

    for (let i = 0; i < 3; i++) {
      await adapter.create({
        model: 'user',
        data: {
          name: marker,
          email: `${marker}-${i}@test.com`,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      })
    }

    const count = await adapter.deleteMany({
      model: 'user',
      where: [{ field: 'name', value: marker, connector: 'AND' }],
    })

    expect(count).toBe(3)
  })
})
