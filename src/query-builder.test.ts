import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { requireWhereClause } from './query-builder.js'

describe('requireWhereClause', () => {
  it('should succeed when clause is provided', async () => {
    const clause = { _tag: 'Fragment' } as never
    const result = await Effect.runPromise(requireWhereClause(clause, 'UPDATE'))
    expect(result).toBe(clause)
  })

  it('should die for UPDATE when clause is null', async () => {
    await expect(Effect.runPromise(requireWhereClause(null, 'UPDATE'))).rejects.toThrow(
      'UPDATE requires WHERE clause',
    )
  })

  it('should die for DELETE when clause is null', async () => {
    await expect(Effect.runPromise(requireWhereClause(null, 'DELETE'))).rejects.toThrow(
      'DELETE requires WHERE clause',
    )
  })

  it('should include operation name in error message', async () => {
    await expect(Effect.runPromise(requireWhereClause(null, 'CUSTOM_OP'))).rejects.toThrow('CUSTOM_OP')
  })
})
