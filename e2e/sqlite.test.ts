import { describe, beforeAll, afterAll } from 'vitest'
import { Effect, ManagedRuntime } from 'effect'
import { SqlClient } from '@effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { runAdapterTest } from 'better-auth/adapters/test'
import { effectSqlAdapter } from '../src/adapter.js'

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
})
