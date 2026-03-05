import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { Effect, ManagedRuntime, Redacted } from 'effect'
import { SqlClient } from '@effect/sql'
import { PgClient } from '@effect/sql-pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { testAdapter } from '@better-auth/test-utils/adapter'
import { effectSqlAdapter } from '../src'
import { adapterTestSuite } from './adapter-test-suite'

let container: StartedPostgreSqlContainer
let managedRuntime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>

const createTables = async () => {
  await managedRuntime.runPromise(
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
}

const setup = async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()

  const SqlLive = PgClient.layer({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: Redacted.make(container.getPassword()),
  })

  managedRuntime = ManagedRuntime.make(SqlLive)
}

await setup()
;(
  await testAdapter({
    adapter: async () => effectSqlAdapter({ runtime: await managedRuntime.runtime(), dialect: 'pg' }),
    runMigrations: createTables,
    tests: [adapterTestSuite()],
    prefixTests: 'PostgreSQL',
    onFinish: async () => {
      await managedRuntime?.dispose()
      await container?.stop()
    },
  })
).execute()

describe('effectSqlAdapter - PostgreSQL (with identifier transforms)', () => {
  let container2: StartedPostgreSqlContainer | undefined
  let managedRuntime2: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown> | undefined
  let factory: ReturnType<typeof effectSqlAdapter>

  const camelToSnake = (str: string) => str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  const snakeToCamel = (str: string) => str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

  beforeAll(async () => {
    container2 = await new PostgreSqlContainer('postgres:16-alpine').start()

    const SqlLive = PgClient.layer({
      host: container2.getHost(),
      port: container2.getPort(),
      database: container2.getDatabase(),
      username: container2.getUsername(),
      password: Redacted.make(container2.getPassword()),
      transformQueryNames: camelToSnake,
      transformResultNames: snakeToCamel,
    })

    managedRuntime2 = ManagedRuntime.make(SqlLive)

    await managedRuntime2.runPromise(
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

    factory = effectSqlAdapter({ runtime: await managedRuntime2.runtime(), dialect: 'pg' })
  }, 60_000)

  afterAll(async () => {
    await managedRuntime2?.dispose()
    await container2?.stop()
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
