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
import { fromContext } from '../src/adapter'
import type { TestDatabase } from './harness'

export interface SuiteOptions {
  /** Tests (by name) to skip in every suite. */
  readonly disableTests?: Readonly<Record<string, boolean>>
}

/** Runs every official `@better-auth/test-utils` adapter suite against `db`. */
export const runOfficialSuites = async (db: TestDatabase, { disableTests = {} }: SuiteOptions = {}): Promise<void> => {
  const suiteOptions = { disableTests }
  const { execute } = await testAdapter({
    adapter: () => fromContext(db.context, { debugLogs: { isRunningAdapterTests: true } }),
    runMigrations: (options) => db.resetSchema(options),
    tests: [
      normalTestSuite(suiteOptions),
      transactionsTestSuite(suiteOptions),
      authFlowTestSuite(suiteOptions),
      numberIdTestSuite(suiteOptions),
      joinsTestSuite(suiteOptions),
      uuidTestSuite(suiteOptions),
      caseInsensitiveTestSuite(suiteOptions),
    ],
    prefixTests: db.dialect,
    onFinish: () => db.dispose(),
  })
  execute()
}
