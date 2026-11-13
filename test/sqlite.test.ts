import { sqliteDatabase } from './harness'
import { runOfficialSuites } from './suites'

await runOfficialSuites(await sqliteDatabase())
