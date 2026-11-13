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
import { Effect, ManagedRuntime } from 'effect'
import { fromContext } from '../src/adapter'
import { dialectOf } from '../src/dialect'
import { type Database, resetSchema } from './harness'

export interface SuiteOptions {
  readonly disableTests?: Readonly<Record<string, boolean>>
}

/** The suites drive Vitest through a Promise API, hence a `ManagedRuntime` rather than a `layer`. */
export const runOfficialSuites = (database: Database, { disableTests = {} }: SuiteOptions = {}) =>
  Effect.gen(function* () {
    const runtime = ManagedRuntime.make(database)
    const context = yield* runtime.contextEffect
    const suiteOptions = { disableTests }
    const { execute } = yield* Effect.promise(() =>
      testAdapter({
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
        prefixTests: runtime.runSync(dialectOf),
        onFinish: () => runtime.dispose(),
      }),
    )
    yield* Effect.sync(execute)
  })
