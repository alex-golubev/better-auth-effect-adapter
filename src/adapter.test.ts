import { describe, it, expect } from 'vitest'

describe('toWhereConditions logic', () => {
  interface Where {
    field: string
    value: unknown
    operator?: string
    connector?: string
  }

  interface WhereCondition {
    field: string
    value: unknown
    operator: string
    connector: string
  }

  // Field names are already mapped by the factory's transformWhereClause,
  // so toWhereConditions just passes them through and applies defaults.
  const toWhereConditions = (where: Where[]): WhereCondition[] =>
    where.map((w) => ({
      field: w.field,
      value: w.value,
      operator: w.operator ?? 'eq',
      connector: w.connector ?? 'AND',
    }))

  it('should convert simple where condition', () => {
    const result = toWhereConditions([{ field: 'id', value: 1 }])
    expect(result).toEqual([{ field: 'id', value: 1, operator: 'eq', connector: 'AND' }])
  })

  it('should use provided operator', () => {
    const result = toWhereConditions([{ field: 'age', value: 18, operator: 'gte' }])
    expect(result).toEqual([{ field: 'age', value: 18, operator: 'gte', connector: 'AND' }])
  })

  it('should use provided connector', () => {
    const result = toWhereConditions([{ field: 'status', value: 'active', connector: 'OR' }])
    expect(result).toEqual([{ field: 'status', value: 'active', operator: 'eq', connector: 'OR' }])
  })

  it('should pass through pre-mapped field names without transformation', () => {
    const result = toWhereConditions([{ field: 'user_email', value: 'test@example.com' }])
    expect(result).toEqual([{ field: 'user_email', value: 'test@example.com', operator: 'eq', connector: 'AND' }])
  })

  it('should handle multiple conditions', () => {
    const result = toWhereConditions([
      { field: 'status', value: 'active' },
      { field: 'role', value: 'admin', operator: 'eq', connector: 'OR' },
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      field: 'status',
      value: 'active',
      operator: 'eq',
      connector: 'AND',
    })
    expect(result[1]).toEqual({
      field: 'role',
      value: 'admin',
      operator: 'eq',
      connector: 'OR',
    })
  })
})

describe('effectSqlAdapter factory', () => {
  it('should be importable', async () => {
    const module = await import('./adapter.js')
    expect(module.effectSqlAdapter).toBeTypeOf('function')
  })
})
