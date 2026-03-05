import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { Effect, ManagedRuntime, Redacted } from 'effect'
import { SqlClient } from '@effect/sql'
import { MysqlClient } from '@effect/sql-mysql2'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import { testAdapter } from '@better-auth/test-utils/adapter'
import { effectSqlAdapter } from '../src'
import { adapterTestSuite } from './adapter-test-suite'

let container: StartedMySqlContainer
let managedRuntime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>

const createTables = async () => {
  await managedRuntime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.all([
        sql`
          CREATE TABLE IF NOT EXISTS user (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) UNIQUE,
            email_address VARCHAR(255),
            emailVerified INTEGER NOT NULL DEFAULT 0,
            image TEXT,
            createdAt VARCHAR(255) NOT NULL,
            updatedAt VARCHAR(255) NOT NULL
          )
        `,
        sql`
          CREATE TABLE IF NOT EXISTS session (
            id VARCHAR(255) PRIMARY KEY,
            expiresAt VARCHAR(255) NOT NULL,
            token VARCHAR(255) NOT NULL UNIQUE,
            createdAt VARCHAR(255) NOT NULL,
            updatedAt VARCHAR(255) NOT NULL,
            ipAddress VARCHAR(255),
            userAgent TEXT,
            userId VARCHAR(255) NOT NULL,
            FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
          )
        `,
        sql`
          CREATE TABLE IF NOT EXISTS account (
            id VARCHAR(255) PRIMARY KEY,
            accountId VARCHAR(255) NOT NULL,
            providerId VARCHAR(255) NOT NULL,
            userId VARCHAR(255) NOT NULL,
            accessToken TEXT,
            refreshToken TEXT,
            idToken TEXT,
            accessTokenExpiresAt VARCHAR(255),
            refreshTokenExpiresAt VARCHAR(255),
            scope TEXT,
            password TEXT,
            createdAt VARCHAR(255) NOT NULL,
            updatedAt VARCHAR(255) NOT NULL,
            FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
          )
        `,
        sql`
          CREATE TABLE IF NOT EXISTS verification (
            id VARCHAR(255) PRIMARY KEY,
            identifier VARCHAR(255) NOT NULL,
            value TEXT NOT NULL,
            expiresAt VARCHAR(255) NOT NULL,
            createdAt VARCHAR(255) NOT NULL,
            updatedAt VARCHAR(255)
          )
        `,
      ]),
    ),
  )
}

const setup = async () => {
  container = await new MySqlContainer('mysql:8.0').start()

  const SqlLive = MysqlClient.layer({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: Redacted.make(container.getUserPassword()),
  })

  managedRuntime = ManagedRuntime.make(SqlLive)
}

await setup()
;(
  await testAdapter({
    adapter: async () => effectSqlAdapter({ runtime: await managedRuntime.runtime(), dialect: 'mysql' }),
    runMigrations: createTables,
    tests: [adapterTestSuite()],
    prefixTests: 'MySQL',
    onFinish: async () => {
      await managedRuntime?.dispose()
      await container?.stop()
    },
  })
).execute()

describe('effectSqlAdapter - MySQL (with identifier transforms)', () => {
  let container2: StartedMySqlContainer | undefined
  let managedRuntime2: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown> | undefined
  let factory: ReturnType<typeof effectSqlAdapter>

  const camelToSnake = (str: string) => str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  const snakeToCamel = (str: string) => str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

  beforeAll(async () => {
    container2 = await new MySqlContainer('mysql:8.0').start()

    const SqlLive = MysqlClient.layer({
      host: container2.getHost(),
      port: container2.getPort(),
      database: container2.getDatabase(),
      username: container2.getUsername(),
      password: Redacted.make(container2.getUserPassword()),
      transformQueryNames: camelToSnake,
      transformResultNames: snakeToCamel,
    })

    managedRuntime2 = ManagedRuntime.make(SqlLive)

    await managedRuntime2.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`
          CREATE TABLE IF NOT EXISTS user (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) UNIQUE,
            email_verified INTEGER NOT NULL DEFAULT 0,
            created_at VARCHAR(255) NOT NULL,
            updated_at VARCHAR(255) NOT NULL
          )
        `),
      ),
    )

    factory = effectSqlAdapter({ runtime: await managedRuntime2.runtime(), dialect: 'mysql' })
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
