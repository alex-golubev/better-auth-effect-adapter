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
import { sqliteDatabase } from './harness'

const db = await sqliteDatabase()

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
  prefixTests: 'sqlite',
  onFinish: () => db.dispose(),
})

execute()
