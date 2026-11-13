import { postgresDatabase } from './harness'
import { runOfficialSuites } from './suites'

// The suites recreate tables with other id types (see `preparedStatements`).
await runOfficialSuites(postgresDatabase({ preparedStatements: false }))
