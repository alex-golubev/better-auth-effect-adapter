import { describe, beforeAll, afterAll, it, expect } from 'vitest'
import { Effect, ManagedRuntime } from 'effect'
import { SqlClient } from '@effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { betterAuth } from 'better-auth/minimal'
import { convertSetCookieToCookie } from 'better-auth/test'
import { effectSqlAdapter } from '../src'

describe('Smoke tests — full better-auth stack', () => {
  const SqliteLive = SqliteClient.layer({ filename: ':memory:' })
  const managedRuntime = ManagedRuntime.make(SqliteLive)
  let auth: ReturnType<typeof betterAuth>

  beforeAll(async () => {
    await managedRuntime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          sql`
            CREATE TABLE IF NOT EXISTS user (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              email TEXT UNIQUE,
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

    auth = betterAuth({
      baseURL: 'http://localhost:3000',
      secret: 'test-secret-that-is-long-enough-for-validation',
      database: effectSqlAdapter({
        runtime: await managedRuntime.runtime(),
        dialect: 'sqlite',
      }),
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: false },
    })
  })

  afterAll(async () => {
    await managedRuntime.dispose()
  })

  it('signUpEmail creates a user and returns user data', async () => {
    const result = await auth.api.signUpEmail({
      body: { email: 'alice@example.com', password: 'password123', name: 'Alice' },
    })
    expect(result.user.email).toBe('alice@example.com')
    expect(result.user.name).toBe('Alice')
    expect(result.user.id).toBeTruthy()
  })

  it('signInEmail authenticates and sets session cookie', async () => {
    const response = await auth.api.signInEmail({
      body: { email: 'alice@example.com', password: 'password123' },
      asResponse: true,
    })
    expect(response.status).toBe(200)
    const setCookie = response.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    expect(setCookie).toContain('better-auth.session_token')
  })

  it('getSession returns valid session after sign-in', async () => {
    const signInResponse = await auth.api.signInEmail({
      body: { email: 'alice@example.com', password: 'password123' },
      asResponse: true,
    })
    const cookieHeaders = convertSetCookieToCookie(signInResponse.headers)

    const session = await auth.api.getSession({ headers: cookieHeaders })
    expect(session).not.toBeNull()
    expect(session!.user.email).toBe('alice@example.com')
    expect(session!.session.userId).toBe(session!.user.id)
  })

  it('getSession returns null for invalid cookie', async () => {
    const headers = new Headers({ cookie: 'better-auth.session_token=invalid-token' })
    const session = await auth.api.getSession({ headers })
    expect(session).toBeNull()
  })
})
