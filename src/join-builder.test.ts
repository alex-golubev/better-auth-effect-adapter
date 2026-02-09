import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import type { SqlClient } from '@effect/sql'
import { collectJoinValues, attachJoinResults, resolveJoins } from './join-builder.js'
import type { JoinConfigEntry } from './join-builder.js'

// --- collectJoinValues ---

describe('collectJoinValues', () => {
  it('should collect values from a column', () => {
    const records = [{ id: 1 }, { id: 2 }, { id: 3 }]
    expect(collectJoinValues(records, 'id')).toEqual([1, 2, 3])
  })

  it('should return empty array for empty records', () => {
    expect(collectJoinValues([], 'id')).toEqual([])
  })

  it('should skip null values', () => {
    const records = [{ id: 1 }, { id: null }, { id: 3 }]
    expect(collectJoinValues(records, 'id')).toEqual([1, 3])
  })

  it('should skip undefined values', () => {
    const records = [{ id: 1 }, { id: undefined }, { id: 3 }]
    expect(collectJoinValues(records, 'id')).toEqual([1, 3])
  })

  it('should skip missing column', () => {
    const records = [{ id: 1 }, { name: 'test' }, { id: 3 }]
    expect(collectJoinValues(records, 'id')).toEqual([1, 3])
  })

  it('should deduplicate values', () => {
    const records = [{ id: 1 }, { id: 2 }, { id: 1 }, { id: 2 }]
    expect(collectJoinValues(records, 'id')).toEqual([1, 2])
  })

  it('should handle string values', () => {
    const records = [{ id: 'a' }, { id: 'b' }, { id: 'a' }]
    expect(collectJoinValues(records, 'id')).toEqual(['a', 'b'])
  })

  it('should handle mixed types without deduplication across types', () => {
    const records = [{ id: 1 }, { id: '1' }]
    // 1 !== '1' so both should be collected
    expect(collectJoinValues(records, 'id')).toEqual([1, '1'])
  })
})

// --- attachJoinResults ---

describe('attachJoinResults', () => {
  describe('one-to-one relation', () => {
    const entry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'one-to-one' }

    it('should attach matching record as object', () => {
      const main = [{ id: 1, name: 'Alice' }]
      const joined = [{ userId: 1, provider: 'github' }]
      const result = attachJoinResults(main, 'account', entry, joined)
      expect(result).toEqual([{ id: 1, name: 'Alice', account: { userId: 1, provider: 'github' } }])
    })

    it('should attach null when no matching record', () => {
      const main = [{ id: 1, name: 'Alice' }]
      const result = attachJoinResults(main, 'account', entry, [])
      expect(result).toEqual([{ id: 1, name: 'Alice', account: null }])
    })

    it('should attach first match when multiple exist', () => {
      const main = [{ id: 1 }]
      const joined = [
        { userId: 1, provider: 'github' },
        { userId: 1, provider: 'google' },
      ]
      const result = attachJoinResults(main, 'account', entry, joined)
      expect(result[0]?.account).toEqual({ userId: 1, provider: 'github' })
    })

    it('should handle multiple main records', () => {
      const main = [{ id: 1 }, { id: 2 }]
      const joined = [{ userId: 2, provider: 'google' }]
      const result = attachJoinResults(main, 'account', entry, joined)
      expect(result[0]?.account).toBeNull()
      expect(result[1]?.account).toEqual({ userId: 2, provider: 'google' })
    })
  })

  describe('one-to-many relation', () => {
    const entry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' }

    it('should attach matching records as array', () => {
      const main = [{ id: 1 }]
      const joined = [
        { userId: 1, token: 'a' },
        { userId: 1, token: 'b' },
      ]
      const result = attachJoinResults(main, 'session', entry, joined)
      expect(result[0]?.session).toEqual([
        { userId: 1, token: 'a' },
        { userId: 1, token: 'b' },
      ])
    })

    it('should attach empty array when no matches', () => {
      const main = [{ id: 1 }]
      const result = attachJoinResults(main, 'session', entry, [])
      expect(result[0]?.session).toEqual([])
    })

    it('should respect limit', () => {
      const limitedEntry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'one-to-many', limit: 2 }
      const main = [{ id: 1 }]
      const joined = [
        { userId: 1, token: 'a' },
        { userId: 1, token: 'b' },
        { userId: 1, token: 'c' },
      ]
      const result = attachJoinResults(main, 'session', limitedEntry, joined)
      expect(result[0]?.session).toHaveLength(2)
    })

    it('should default limit to 100', () => {
      const noLimitEntry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' }
      const main = [{ id: 1 }]
      // Create 101 joined rows
      const joined = Array.from({ length: 101 }, (_, i) => ({ userId: 1, token: `t${i}` }))
      const result = attachJoinResults(main, 'session', noLimitEntry, joined)
      expect((result[0]?.session as unknown[]).length).toBe(100)
    })

    it('should handle multiple main records independently', () => {
      const main = [{ id: 1 }, { id: 2 }]
      const joined = [
        { userId: 1, token: 'a' },
        { userId: 2, token: 'b' },
        { userId: 2, token: 'c' },
      ]
      const result = attachJoinResults(main, 'session', entry, joined)
      expect(result[0]?.session).toEqual([{ userId: 1, token: 'a' }])
      expect(result[1]?.session).toEqual([
        { userId: 2, token: 'b' },
        { userId: 2, token: 'c' },
      ])
    })
  })

  describe('many-to-many relation', () => {
    it('should behave same as one-to-many (array output)', () => {
      const entry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'many-to-many', limit: 50 }
      const main = [{ id: 1 }]
      const joined = [
        { userId: 1, role: 'admin' },
        { userId: 1, role: 'user' },
      ]
      const result = attachJoinResults(main, 'role', entry, joined)
      expect(result[0]?.role).toEqual([
        { userId: 1, role: 'admin' },
        { userId: 1, role: 'user' },
      ])
    })
  })

  describe('default relation', () => {
    it('should default to one-to-many when relation is undefined', () => {
      const entry: JoinConfigEntry = { on: { from: 'id', to: 'userId' } }
      const main = [{ id: 1 }]
      const joined = [
        { userId: 1, token: 'a' },
        { userId: 1, token: 'b' },
      ]
      const result = attachJoinResults(main, 'session', entry, joined)
      expect(Array.isArray(result[0]?.session)).toBe(true)
      expect(result[0]?.session).toHaveLength(2)
    })
  })

  describe('edge cases', () => {
    it('should return empty array for empty main records', () => {
      const entry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' }
      const result = attachJoinResults([], 'session', entry, [])
      expect(result).toEqual([])
    })

    it('should handle null join key in main record', () => {
      const entry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' }
      const main = [{ id: null }]
      const joined = [{ userId: 1, token: 'a' }]
      const result = attachJoinResults(main, 'session', entry, joined)
      expect(result[0]?.session).toEqual([])
    })

    it('should handle null join key in joined rows', () => {
      const entry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' }
      const main = [{ id: 1 }]
      const joined = [{ userId: null, token: 'a' }]
      const result = attachJoinResults(main, 'session', entry, joined)
      expect(result[0]?.session).toEqual([])
    })

    it('should not mutate original main records', () => {
      const entry: JoinConfigEntry = { on: { from: 'id', to: 'userId' }, relation: 'one-to-one' }
      const main = [{ id: 1, name: 'Alice' }]
      const originalMain = { ...main[0]! }
      attachJoinResults(main, 'account', entry, [{ userId: 1, provider: 'github' }])
      expect(main[0]).toEqual(originalMain)
      expect(main[0]).not.toHaveProperty('account')
    })

    it('should handle duplicate join keys across main records', () => {
      const entry: JoinConfigEntry = { on: { from: 'groupId', to: 'groupId' }, relation: 'one-to-many' }
      const main = [
        { id: 1, groupId: 'g1' },
        { id: 2, groupId: 'g1' },
      ]
      const joined = [{ groupId: 'g1', role: 'admin' }]
      const result = attachJoinResults(main, 'membership', entry, joined)
      // Both records share the same groupId so both get the same joined data
      expect(result[0]?.membership).toEqual([{ groupId: 'g1', role: 'admin' }])
      expect(result[1]?.membership).toEqual([{ groupId: 'g1', role: 'admin' }])
    })
  })
})

// --- resolveJoins ---

describe('resolveJoins', () => {
  /**
   * Creates a mock SqlClient that tracks queries and returns configurable results.
   * The mock intercepts tagged template calls to capture the generated SQL.
   */
  const createMockSqlClient = (queryResults: Record<string, unknown>[][] = []) => {
    const queriesCalled: string[] = []
    let queryIndex = 0

    const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      let queryStr = ''
      for (let i = 0; i < strings.length; i++) {
        queryStr += strings[i]
        if (i < values.length) {
          const v = values[i]
          if (typeof v === 'object' && v !== null && '__fragment' in v) {
            queryStr += (v as { __fragment: string }).__fragment
          } else if (v === null) {
            queryStr += 'NULL'
          } else if (typeof v === 'string') {
            queryStr += `'${v}'`
          } else {
            queryStr += String(v)
          }
        }
      }
      queriesCalled.push(queryStr.trim())

      const results = queryResults[queryIndex] ?? []
      queryIndex++

      // Return an Effect-like object that resolves to results
      return Effect.succeed(results)
    }

    const identifier = (name: string) => ({ __fragment: `"${name}"` })

    const mockSql = Object.assign(
      (stringsOrIdentifier: TemplateStringsArray | string, ...values: unknown[]) => {
        if (typeof stringsOrIdentifier === 'string') {
          return identifier(stringsOrIdentifier)
        }
        return sqlFn(stringsOrIdentifier, ...values)
      },
      {
        literal: (value: string) => ({ __fragment: value }),
        in: (values: readonly unknown[]) => ({
          __fragment: `(${values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')})`,
        }),
        and: (conditions: { __fragment: string }[]) => ({
          __fragment: conditions.map((c) => `(${c.__fragment})`).join(' AND '),
        }),
        or: (conditions: { __fragment: string }[]) => ({
          __fragment: conditions.map((c) => c.__fragment).join(' OR '),
        }),
      },
    )

    return { mockSql: mockSql as unknown as SqlClient.SqlClient, queriesCalled }
  }

  it('should return empty array for empty main records', async () => {
    const { mockSql, queriesCalled } = createMockSqlClient()
    const joinConfig = { session: { on: { from: 'id', to: 'userId' } } }

    const result = await Effect.runPromise(resolveJoins(mockSql, [], joinConfig))

    expect(result).toEqual([])
    expect(queriesCalled).toHaveLength(0)
  })

  it('should return copies of main records for empty join config', async () => {
    const { mockSql, queriesCalled } = createMockSqlClient()
    const mainRecords = [{ id: 1, name: 'Alice' }]

    const result = await Effect.runPromise(resolveJoins(mockSql, mainRecords, {}))

    expect(result).toEqual([{ id: 1, name: 'Alice' }])
    expect(result[0]).not.toBe(mainRecords[0]) // Shallow copy
    expect(queriesCalled).toHaveLength(0)
  })

  it('should execute one query per joined model', async () => {
    const { mockSql, queriesCalled } = createMockSqlClient([
      [{ userId: 1, token: 'tok1' }],
      [{ userId: 1, provider: 'github' }],
    ])
    const mainRecords = [{ id: 1 }]
    const joinConfig = {
      session: { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' as const },
      account: { on: { from: 'id', to: 'userId' }, relation: 'one-to-one' as const },
    }

    const result = await Effect.runPromise(resolveJoins(mockSql, mainRecords, joinConfig))

    expect(queriesCalled).toHaveLength(2)
    expect(queriesCalled[0]).toContain('"session"')
    expect(queriesCalled[1]).toContain('"account"')
    expect(result[0]?.session).toEqual([{ userId: 1, token: 'tok1' }])
    expect(result[0]?.account).toEqual({ userId: 1, provider: 'github' })
  })

  it('should use IN clause with collected values', async () => {
    const { mockSql, queriesCalled } = createMockSqlClient([[]])
    const mainRecords = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const joinConfig = { session: { on: { from: 'id', to: 'userId' } } }

    await Effect.runPromise(resolveJoins(mockSql, mainRecords, joinConfig))

    expect(queriesCalled).toHaveLength(1)
    expect(queriesCalled[0]).toContain('(1, 2, 3)')
  })

  it('should skip query when no non-null join values exist', async () => {
    const { mockSql, queriesCalled } = createMockSqlClient()
    const mainRecords = [{ id: null }, { id: undefined }]
    const joinConfig = { session: { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' as const } }

    const result = await Effect.runPromise(resolveJoins(mockSql, mainRecords, joinConfig))

    expect(queriesCalled).toHaveLength(0)
    expect(result[0]?.session).toEqual([])
    expect(result[1]?.session).toEqual([])
  })

  it('should handle mixed one-to-one and one-to-many correctly', async () => {
    const { mockSql } = createMockSqlClient([
      [{ userId: 1, provider: 'github' }],
      [
        { userId: 1, token: 'a' },
        { userId: 1, token: 'b' },
      ],
    ])
    const mainRecords = [{ id: 1, name: 'Alice' }]
    const joinConfig = {
      account: { on: { from: 'id', to: 'userId' }, relation: 'one-to-one' as const },
      session: { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' as const },
    }

    const result = await Effect.runPromise(resolveJoins(mockSql, mainRecords, joinConfig))

    expect(result[0]?.account).toEqual({ userId: 1, provider: 'github' })
    expect(result[0]?.session).toEqual([
      { userId: 1, token: 'a' },
      { userId: 1, token: 'b' },
    ])
    expect(result[0]?.name).toBe('Alice')
  })

  it('should handle multiple main records with different join values', async () => {
    const { mockSql } = createMockSqlClient([
      [
        { userId: 1, token: 'a' },
        { userId: 2, token: 'b' },
        { userId: 2, token: 'c' },
      ],
    ])
    const mainRecords = [{ id: 1 }, { id: 2 }]
    const joinConfig = { session: { on: { from: 'id', to: 'userId' }, relation: 'one-to-many' as const } }

    const result = await Effect.runPromise(resolveJoins(mockSql, mainRecords, joinConfig))

    expect(result[0]?.session).toEqual([{ userId: 1, token: 'a' }])
    expect(result[1]?.session).toEqual([
      { userId: 2, token: 'b' },
      { userId: 2, token: 'c' },
    ])
  })

  it('should deduplicate join key values in IN clause', async () => {
    const { mockSql, queriesCalled } = createMockSqlClient([[]])
    const mainRecords = [{ groupId: 'g1' }, { groupId: 'g1' }, { groupId: 'g2' }]
    const joinConfig = { member: { on: { from: 'groupId', to: 'groupId' } } }

    await Effect.runPromise(resolveJoins(mockSql, mainRecords, joinConfig))

    expect(queriesCalled).toHaveLength(1)
    expect(queriesCalled[0]).toContain("('g1', 'g2')")
  })
})
