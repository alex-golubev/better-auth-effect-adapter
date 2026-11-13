import { Effect } from 'effect'
import { sqliteDatabase } from './harness'
import { runOfficialSuites } from './suites'

await Effect.runPromise(runOfficialSuites(sqliteDatabase()))
