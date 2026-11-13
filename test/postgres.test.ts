import { postgresDatabase } from './harness'
import { runOfficialSuites } from './suites'

// The suites recreate tables with different id types on one pool (see `preparedStatements`).
await runOfficialSuites(postgresDatabase({ preparedStatements: false }))
