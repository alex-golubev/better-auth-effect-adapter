import { describe, expect, it } from 'vitest'
import type { WhereCondition } from './where-builder.js'
import { buildWhereClause } from './where-builder.js'

const createMockSql = () => {
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let result = ''
    for (let i = 0; i < strings.length; i++) {
      result += strings[i]
      if (i < values.length) {
        const v = values[i]
        if (typeof v === 'object' && v !== null && '__fragment' in v) {
          result += (v as { __fragment: string }).__fragment
        } else if (v === null) {
          result += 'NULL'
        } else if (typeof v === 'string') {
          result += `'${v}'`
        } else {
          result += String(v)
        }
      }
    }
    return { __fragment: result }
  }

  sqlFn.literal = (value: string) => ({ __fragment: value })

  const identifier = (name: string) => {
    const result = `"${name}"`
    return { __fragment: result }
  }

  return Object.assign(
    (stringsOrIdentifier: TemplateStringsArray | string, ...values: unknown[]) => {
      if (typeof stringsOrIdentifier === 'string') {
        return identifier(stringsOrIdentifier)
      }
      return sqlFn(stringsOrIdentifier, ...values)
    },
    {
      literal: sqlFn.literal,
      and: (conditions: { __fragment: string }[]) => ({
        __fragment: conditions.map((c) => `(${c.__fragment})`).join(' AND '),
      }),
      or: (conditions: { __fragment: string }[]) => ({
        __fragment: conditions.map((c) => c.__fragment).join(' OR '),
      }),
      in: (values: readonly unknown[]) => ({
        __fragment: `(${values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')})`,
      }),
      join: (_separator: string, _wrapped: boolean, _fallback: string) => (items: { __fragment: string }[]) => ({
        __fragment: items.map((i) => i.__fragment).join(', '),
      }),
      insert: () => ({ __fragment: 'INSERT_DATA' }),
      update: () => ({ __fragment: 'UPDATE_DATA' }),
    },
  )
}

const getFragment = (result: unknown): string => {
  if (result && typeof result === 'object' && '__fragment' in result) {
    return (result as { __fragment: string }).__fragment
  }
  throw new Error('Expected fragment object')
}

describe('groupByConnector logic', () => {
  interface WhereCondition {
    field: string
    value: unknown
    operator: string
    connector: 'AND' | 'OR'
  }

  const groupByConnector = (conditions: readonly WhereCondition[]): { and: WhereCondition[]; or: WhereCondition[] } =>
    conditions.reduce(
      (acc, condition) => {
        acc[condition.connector === 'AND' ? 'and' : 'or'].push(condition)
        return acc
      },
      { and: [] as WhereCondition[], or: [] as WhereCondition[] },
    )

  it('should return empty arrays for empty conditions', () => {
    const result = groupByConnector([])
    expect(result).toEqual({ and: [], or: [] })
  })

  it('should group AND conditions correctly', () => {
    const conditions: WhereCondition[] = [
      { field: 'id', value: 1, operator: 'eq', connector: 'AND' },
      { field: 'status', value: 'active', operator: 'eq', connector: 'AND' },
    ]
    const result = groupByConnector(conditions)
    expect(result.and).toHaveLength(2)
    expect(result.or).toHaveLength(0)
  })

  it('should group OR conditions correctly', () => {
    const conditions: WhereCondition[] = [
      { field: 'role', value: 'admin', operator: 'eq', connector: 'OR' },
      { field: 'role', value: 'user', operator: 'eq', connector: 'OR' },
    ]
    const result = groupByConnector(conditions)
    expect(result.and).toHaveLength(0)
    expect(result.or).toHaveLength(2)
  })

  it('should separate AND and OR conditions', () => {
    const conditions: WhereCondition[] = [
      { field: 'status', value: 'active', operator: 'eq', connector: 'AND' },
      { field: 'age', value: 18, operator: 'gte', connector: 'AND' },
      { field: 'role', value: 'admin', operator: 'eq', connector: 'OR' },
      { field: 'role', value: 'moderator', operator: 'eq', connector: 'OR' },
    ]
    const result = groupByConnector(conditions)
    expect(result.and).toHaveLength(2)
    expect(result.or).toHaveLength(2)
    expect(result.and[0]?.field).toBe('status')
    expect(result.and[1]?.field).toBe('age')
    expect(result.or[0]?.field).toBe('role')
    expect(result.or[1]?.field).toBe('role')
  })

  it('should preserve condition order within groups', () => {
    const conditions: WhereCondition[] = [
      { field: 'a', value: 1, operator: 'eq', connector: 'AND' },
      { field: 'b', value: 2, operator: 'eq', connector: 'OR' },
      { field: 'c', value: 3, operator: 'eq', connector: 'AND' },
      { field: 'd', value: 4, operator: 'eq', connector: 'OR' },
    ]
    const result = groupByConnector(conditions)
    expect(result.and.map((c) => c.field)).toEqual(['a', 'c'])
    expect(result.or.map((c) => c.field)).toEqual(['b', 'd'])
  })
})

describe('buildWhereClause', () => {
  describe('empty conditions', () => {
    it('should return null for empty conditions array', () => {
      const sql = createMockSql()
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], [])
      expect(result).toBeNull()
    })
  })

  describe('single AND condition', () => {
    it('should handle eq operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'id', value: 1, operator: 'eq', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      const fragment = getFragment(result)
      expect(fragment).toContain('"id"')
      expect(fragment).toContain('=')
    })

    it('should handle eq with null value', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'deleted_at', value: null, operator: 'eq', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('IS NULL')
    })

    it('should handle ne operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'status', value: 'deleted', operator: 'ne', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('<>')
    })

    it('should handle ne with null value', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'deleted_at', value: null, operator: 'ne', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('IS NOT NULL')
    })

    it('should handle lt operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'age', value: 18, operator: 'lt', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('<')
    })

    it('should handle lte operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'age', value: 18, operator: 'lte', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('<=')
    })

    it('should handle gt operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'score', value: 100, operator: 'gt', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('>')
    })

    it('should handle gte operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'score', value: 100, operator: 'gte', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('>=')
    })
  })

  describe('IN and NOT IN operators', () => {
    it('should handle in operator with array', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'status', value: ['active', 'pending'], operator: 'in', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('IN')
    })

    it('should handle in operator with empty array (returns false)', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'status', value: [], operator: 'in', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('1 = 0')
    })

    it('should handle not_in operator with array', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'role', value: ['admin', 'superadmin'], operator: 'not_in', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('NOT IN')
    })

    it('should handle not_in operator with empty array (returns true)', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'role', value: [], operator: 'not_in', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('1 = 1')
    })

    it('should handle in operator with non-array value (returns false)', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'status', value: 'active' as unknown as string[], operator: 'in', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('1 = 0')
    })

    it('should handle not_in operator with non-array value (returns true)', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'role', value: 42 as unknown as number[], operator: 'not_in', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('1 = 1')
    })
  })

  describe('LIKE operators', () => {
    it('should handle contains operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'name', value: 'john', operator: 'contains', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      const fragment = getFragment(result)
      expect(fragment).toContain('LIKE')
      expect(fragment).toContain('%john%')
    })

    it('should handle starts_with operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'email', value: 'test', operator: 'starts_with', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      const fragment = getFragment(result)
      expect(fragment).toContain('LIKE')
      expect(fragment).toContain('test%')
    })

    it('should handle ends_with operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'email', value: '@example.com', operator: 'ends_with', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      const fragment = getFragment(result)
      expect(fragment).toContain('LIKE')
      expect(fragment).toContain('%@example.com')
    })

    it('should escape special LIKE characters in contains', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'pattern', value: '100%', operator: 'contains', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('100\\%')
    })

    it('should escape underscore in LIKE patterns', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'name', value: 'user_name', operator: 'contains', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('user\\_name')
    })

    it('should escape backslash in LIKE patterns', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'path', value: 'C:\\path', operator: 'contains', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('C:\\\\path')
    })

    it('should escape % in starts_with', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'discount', value: '50%', operator: 'starts_with', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('50\\%')
    })

    it('should escape _ in ends_with', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'code', value: 'test_v1', operator: 'ends_with', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('test\\_v1')
    })

    it('should escape backslash in starts_with', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'path', value: '\\root', operator: 'starts_with', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('\\\\root')
    })

    it('should escape multiple special chars in ends_with', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'name', value: '50%_off', operator: 'ends_with', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('50\\%\\_off')
    })
  })

  describe('multiple conditions', () => {
    it('should combine multiple AND conditions', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'status', value: 'active', operator: 'eq', connector: 'AND' },
        { field: 'age', value: 18, operator: 'gte', connector: 'AND' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('AND')
    })

    it('should handle OR conditions', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'role', value: 'admin', operator: 'eq', connector: 'OR' },
        { field: 'role', value: 'superadmin', operator: 'eq', connector: 'OR' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      expect(getFragment(result)).toContain('OR')
    })

    it('should combine AND and OR conditions', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [
        { field: 'status', value: 'active', operator: 'eq', connector: 'AND' },
        { field: 'role', value: 'admin', operator: 'eq', connector: 'OR' },
        { field: 'role', value: 'user', operator: 'eq', connector: 'OR' },
      ]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      const fragment = getFragment(result)
      expect(fragment).toContain('AND')
      expect(fragment).toContain('OR')
    })
  })

  describe('Date handling', () => {
    it('should convert Date to ISO string for comparison operators', () => {
      const sql = createMockSql()
      const date = new Date('2024-01-15T10:00:00Z')
      const conditions: WhereCondition[] = [{ field: 'created_at', value: date, operator: 'gt', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      const fragment = getFragment(result)
      expect(fragment).toContain('2024-01-15T10:00:00.000Z')
    })
  })

  describe('boolean conversion', () => {
    it('should convert boolean true to 1 for eq operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'emailVerified', value: true, operator: 'eq', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      const fragment = getFragment(result)
      expect(fragment).toContain('1')
      expect(fragment).not.toContain('true')
    })

    it('should convert boolean false to 0 for eq operator', () => {
      const sql = createMockSql()
      const conditions: WhereCondition[] = [{ field: 'emailVerified', value: false, operator: 'eq', connector: 'AND' }]
      const result = buildWhereClause(sql as unknown as Parameters<typeof buildWhereClause>[0], conditions)
      expect(result).not.toBeNull()
      const fragment = getFragment(result)
      expect(fragment).toContain('0')
      expect(fragment).not.toContain('false')
    })
  })
})
