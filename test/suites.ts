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

/** Runs every official `@better-auth/test-utils` adapter suite against `db`. */
export const runOfficialSuites = async (db: TestDatabase): Promise<void> => {
  const { execute } = await testAdapter({
    adapter: () => fromContext(db.context, { debugLogs: { isRunningAdapterTests: true } }),
    runMigrations: (options) => db.resetSchema(options),
    tests: [
      normalTestSuite(),
      transactionsTestSuite(),
      authFlowTestSuite(),
      numberIdTestSuite(),
      joinsTestSuite(),
      uuidTestSuite(),
      caseInsensitiveTestSuite(),
    ],
    prefixTests: db.dialect,
    onFinish: () => db.dispose(),
  })
  execute()
}
