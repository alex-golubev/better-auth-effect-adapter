import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  joinsTestSuite,
  normalTestSuite,
  numberIdTestSuite,
  testAdapter,
  transactionsTestSuite,
  uuidTestSuite,
} from '@better-auth/test-utils/adapter'
import { ManagedRuntime } from 'effect'
import { fromContext } from '../src/adapter'
import { type Database, dialectOf, resetSchema } from './harness'

export interface SuiteOptions {
  /** Tests (by name) to skip in every suite. */
  readonly disableTests?: Readonly<Record<string, boolean>>
}

/**
 * Runs every official `@better-auth/test-utils` adapter suite against `database`.
 * The suites drive Vitest themselves through a Promise API, so the database runs on a
 * `ManagedRuntime` here instead of an `@effect/vitest` layer.
 */
export const runOfficialSuites = async (
  database: Database,
  { disableTests = {} }: SuiteOptions = {},
): Promise<void> => {
  const runtime = ManagedRuntime.make(database)
  const context = await runtime.context()
  const suiteOptions = { disableTests }
  const { execute } = await testAdapter({
    adapter: () => fromContext(context, { debugLogs: { isRunningAdapterTests: true } }),
    runMigrations: (options) => runtime.runPromise(resetSchema(options)),
    tests: [
      normalTestSuite(suiteOptions),
      transactionsTestSuite(suiteOptions),
      authFlowTestSuite(suiteOptions),
      numberIdTestSuite(suiteOptions),
      joinsTestSuite(suiteOptions),
      uuidTestSuite(suiteOptions),
      caseInsensitiveTestSuite(suiteOptions),
    ],
    prefixTests: await runtime.runPromise(dialectOf),
    onFinish: () => runtime.dispose(),
  })
  execute()
}
