import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { Context, Effect, Layer } from 'effect'
import { make } from '../src/adapter'

export const authOptions = {
  baseURL: 'http://localhost:3000',
  secret: 'integration-test-secret-that-is-long-enough-for-better-auth',
  emailAndPassword: { enabled: true },
  logger: { disabled: true },
  telemetry: { enabled: false },
} satisfies BetterAuthOptions

/** better-auth on the SqlClient in context, built the way the README tells apps to build it. */
export class Auth extends Context.Service<Auth>()('test/Auth', {
  make: Effect.map(make(), (database) => betterAuth({ ...authOptions, database })),
}) {
  static readonly layer = Layer.effect(Auth, Auth.make)
}

export const signUpBody = (email: string) => ({ email, password: 'password1234', name: 'Test User' })
