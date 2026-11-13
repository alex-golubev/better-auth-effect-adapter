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
import { dialectOf } from '../src/dialect'
import { type Database, resetSchema } from './harness'

export interface SuiteOptions {
  readonly disableTests?: Readonly<Record<string, boolean>>
}

/** The suites drive Vitest through a Promise API, hence a `ManagedRuntime` rather than a `layer`. */
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
