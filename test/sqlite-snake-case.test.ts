// snake_case columns through the SqlClient's name transforms: the generated schema and the
// adapter's queries must agree on every table and column name.
import { sqliteDatabase } from './harness'
import { runOfficialSuites } from './suites'

await runOfficialSuites(sqliteDatabase({ snakeCase: true }), {
  // These rename `email` to `email_address` through better-auth's `fields`. With result name
  // transforms that can't work: the column comes back as `emailAddress` (snakeToCamel), not under
  // the physical name better-auth asks for. Next to driver transforms, physical names stay camelCase.
  disableTests: {
    'findOne - should find a model with modified field name': true,
    'findOne - should join a model with modified field name': true,
  },
})
