import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { Effect, ManagedRuntime, Redacted } from 'effect'
import { SqlClient } from '@effect/sql'
import { PgClient } from '@effect/sql-pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { runAdapterTest } from 'better-auth/adapters/test'
import { effectSqlAdapter } from '../src'

describe('effectSqlAdapter - PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown> | undefined
  let factory: ReturnType<typeof effectSqlAdapter>

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()

    const SqlLive = PgClient.layer({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      username: container.getUsername(),
      password: Redacted.make(container.getPassword()),
    })

    runtime = ManagedRuntime.make(SqlLive)

    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          sql`
            CREATE TABLE IF NOT EXISTS "user" (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              email TEXT UNIQUE,
              email_address TEXT,
              "emailVerified" INTEGER NOT NULL DEFAULT 0,
              image TEXT,
              "createdAt" TEXT NOT NULL,
              "updatedAt" TEXT NOT NULL
            )
          `,
          sql`
            CREATE TABLE IF NOT EXISTS session (
              id TEXT PRIMARY KEY,
              "expiresAt" TEXT NOT NULL,
              token TEXT NOT NULL UNIQUE,
              "createdAt" TEXT NOT NULL,
              "updatedAt" TEXT NOT NULL,
              "ipAddress" TEXT,
              "userAgent" TEXT,
              "userId" TEXT NOT NULL,
              FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE
            )
          `,
          sql`
            CREATE TABLE IF NOT EXISTS account (
              id TEXT PRIMARY KEY,
              "accountId" TEXT NOT NULL,
              "providerId" TEXT NOT NULL,
              "userId" TEXT NOT NULL,
              "accessToken" TEXT,
              "refreshToken" TEXT,
              "idToken" TEXT,
              "accessTokenExpiresAt" TEXT,
              "refreshTokenExpiresAt" TEXT,
              scope TEXT,
              password TEXT,
              "createdAt" TEXT NOT NULL,
              "updatedAt" TEXT NOT NULL,
              FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE CASCADE
            )
          `,
          sql`
            CREATE TABLE IF NOT EXISTS verification (
              id TEXT PRIMARY KEY,
              identifier TEXT NOT NULL,
              value TEXT NOT NULL,
              "expiresAt" TEXT NOT NULL,
              "createdAt" TEXT NOT NULL,
              "updatedAt" TEXT
            )
          `,
        ]),
      ),
    )

    factory = effectSqlAdapter({ runtime, dialect: 'pg' })
  }, 60_000)

  afterAll(async () => {
    await runtime?.dispose()
    await container?.stop()
  })

  runAdapterTest({
    getAdapter: async (customOptions) => factory(customOptions ?? {}),
    testPrefix: 'PostgreSQL',
  })

  it('PostgreSQL - updateMany should return correct affected row count', async () => {
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

  it('PostgreSQL - deleteMany should return correct affected row count', async () => {
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

describe('effectSqlAdapter - PostgreSQL (with identifier transforms)', () => {
  let container: StartedPostgreSqlContainer | undefined
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown> | undefined
  let factory: ReturnType<typeof effectSqlAdapter>

  const camelToSnake = (str: string) => str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  const snakeToCamel = (str: string) => str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()

    const SqlLive = PgClient.layer({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      username: container.getUsername(),
      password: Redacted.make(container.getPassword()),
      transformQueryNames: camelToSnake,
      transformResultNames: snakeToCamel,
    })

    runtime = ManagedRuntime.make(SqlLive)

    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`
          CREATE TABLE IF NOT EXISTS "user" (
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

    factory = effectSqlAdapter({ runtime, dialect: 'pg' })
  }, 60_000)

  afterAll(async () => {
    await runtime?.dispose()
    await container?.stop()
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
