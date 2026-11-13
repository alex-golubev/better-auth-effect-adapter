import { mysqlDatabase } from './harness'
import { runOfficialSuites } from './suites'

// The suites recreate tables with other id types (see `preparedStatements`).
await runOfficialSuites(mysqlDatabase({ preparedStatements: false }))
