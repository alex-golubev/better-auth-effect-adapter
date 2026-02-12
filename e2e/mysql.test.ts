import { describe, beforeAll, afterAll } from 'vitest'
import { Effect, ManagedRuntime, Redacted } from 'effect'
import { SqlClient } from '@effect/sql'
import { MysqlClient } from '@effect/sql-mysql2'
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql'
import { runAdapterTest } from 'better-auth/adapters/test'
import { effectSqlAdapter } from '../src'

describe('effectSqlAdapter - MySQL', () => {
  let container: StartedMySqlContainer | undefined
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown> | undefined
  let factory: ReturnType<typeof effectSqlAdapter>

  beforeAll(async () => {
    container = await new MySqlContainer('mysql:8.0').start()

    const SqlLive = MysqlClient.layer({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      username: container.getUsername(),
      password: Redacted.make(container.getUserPassword()),
    })

    runtime = ManagedRuntime.make(SqlLive)

    await runtime.runPromise(
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

    factory = effectSqlAdapter({ runtime, dialect: 'mysql' })
  }, 60_000)

  afterAll(async () => {
    await runtime?.dispose()
    await container?.stop()
  })

  runAdapterTest({
    getAdapter: async (customOptions) => factory(customOptions ?? {}),
    testPrefix: 'MySQL',
  })
})
