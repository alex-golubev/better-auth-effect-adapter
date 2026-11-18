import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EffectSqlAdapterError } from './errors'
import { affectedRows } from './operations'

describe('affectedRows', () => {
  it.effect("reads mysql2's count, as a number or a bigint", () =>
    Effect.gen(function* () {
      expect(yield* affectedRows({ fieldCount: 0, affectedRows: 2, insertId: 0 })).toBe(2)
      expect(yield* affectedRows({ affectedRows: 4n })).toBe(4)
    }),
  )

  it.effect('fails when no count is reported', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(affectedRows([]))).toBeInstanceOf(EffectSqlAdapterError)
      expect(yield* Effect.flip(affectedRows({ changes: 2 }))).toBeInstanceOf(EffectSqlAdapterError)
      expect(yield* Effect.flip(affectedRows(undefined))).toBeInstanceOf(EffectSqlAdapterError)
    }),
  )
})
