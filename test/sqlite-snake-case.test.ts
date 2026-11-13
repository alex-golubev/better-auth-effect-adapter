// Under the client's name transforms, the generated schema and the adapter's queries must agree on names.
import { sqliteDatabase } from './harness'
import { runOfficialSuites } from './suites'

await runOfficialSuites(sqliteDatabase({ snakeCase: true }), {
  // `fields: { email: 'email_address' }` can't work with result transforms: the column comes back
  // as `emailAddress`. Next to driver transforms, better-auth's names stay camelCase.
  disableTests: {
    'findOne - should find a model with modified field name': true,
    'findOne - should join a model with modified field name': true,
  },
})
