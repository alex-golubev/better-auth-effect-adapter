import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EffectSqlAdapterError } from './errors'
import { affectedRows } from './operations'

describe('affectedRows', () => {
  it.effect('reads the count whichever driver reported it', () =>
    Effect.gen(function* () {
      expect(yield* affectedRows({ changes: 2, lastInsertRowid: 7 })).toBe(2)
      expect(yield* affectedRows({ rowCount: 3 })).toBe(3)
      expect(yield* affectedRows({ affectedRows: 4n })).toBe(4)
      expect(yield* affectedRows({ rowsAffected: 5 })).toBe(5)
    }),
  )

  it.effect('fails when no count is reported', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(affectedRows({ rows: [] }))).toBeInstanceOf(EffectSqlAdapterError)
      expect(yield* Effect.flip(affectedRows(undefined))).toBeInstanceOf(EffectSqlAdapterError)
    }),
  )
})
