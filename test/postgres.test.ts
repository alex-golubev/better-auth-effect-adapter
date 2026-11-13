import { Effect } from 'effect'
import { postgresDatabase } from './harness'
import { runOfficialSuites } from './suites'

// The suites recreate tables with other id types (see `preparedStatements`).
await Effect.runPromise(runOfficialSuites(postgresDatabase({ preparedStatements: false })))
