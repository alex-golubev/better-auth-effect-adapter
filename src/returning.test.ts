import { describe, it, expect } from 'vitest'
import { Effect, Option, pipe } from 'effect'
import { getReturningStrategy } from './returning.js'

describe('requireRow logic', () => {
  // Mimics the requireRow helper from returning.ts using Effect
  // For testability, we create a synchronous version that returns Option
  const requireRowSync = <T>(row: T | undefined): Option.Option<T> => Option.fromNullable(row)

  it('should return Some for defined value', () => {
    const row = { id: 1, name: 'test' }
    const result = requireRowSync(row)
    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrNull(result)).toEqual(row)
  })

  it('should return None for undefined', () => {
    const result = requireRowSync(undefined)
    expect(Option.isNone(result)).toBe(true)
  })

  it('should return None for null', () => {
    const result = requireRowSync(null)
    expect(Option.isNone(result)).toBe(true)
  })

  it('should handle empty object', () => {
    const row = {}
    const result = requireRowSync(row)
    expect(Option.isSome(result)).toBe(true)
  })

  it('should handle zero value', () => {
    const result = requireRowSync(0)
    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrNull(result)).toBe(0)
  })

  it('should handle empty string', () => {
    const result = requireRowSync('')
    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrNull(result)).toBe('')
  })

  it('should handle false boolean', () => {
    const result = requireRowSync(false)
    expect(Option.isSome(result)).toBe(true)
    expect(Option.getOrNull(result)).toBe(false)
  })
})

describe('requireRow Effect behavior', () => {
  // Full Effect-based version matching the actual implementation
  const requireRow = <T>(row: T | undefined, errorMessage: string): Effect.Effect<T, never, never> =>
    pipe(
      row,
      Option.fromNullable,
      Option.match({
        onNone: () => Effect.die(new Error(errorMessage)),
        onSome: Effect.succeed,
      }),
    )

  it('should succeed with value when row exists', async () => {
    const row = { id: 1, name: 'test' }
    const effect = requireRow(row, 'Row not found')
    const result = await Effect.runPromise(effect)
    expect(result).toEqual(row)
  })

  it('should die when row is undefined', async () => {
    const effect = requireRow(undefined, 'INSERT returned no rows')
    await expect(Effect.runPromise(effect)).rejects.toThrow('INSERT returned no rows')
  })

  it('should die when row is null', async () => {
    const effect = requireRow(null, 'Row not found')
    await expect(Effect.runPromise(effect)).rejects.toThrow('Row not found')
  })

  it('should include table name in error message', async () => {
    const effect = requireRow(undefined, 'INSERT into "users" returned no rows')
    await expect(Effect.runPromise(effect)).rejects.toThrow('INSERT into "users" returned no rows')
  })

  it('should include context in error message', async () => {
    const effect = requireRow(undefined, 'INSERT into "sessions" returned no rows (LAST_INSERT_ID)')
    await expect(Effect.runPromise(effect)).rejects.toThrow('LAST_INSERT_ID')
  })
})

describe('getReturningStrategy', () => {
  describe('dialect selection', () => {
    it("should return pg strategy for 'pg' dialect", () => {
      const strategy = getReturningStrategy('pg')
      expect(strategy).toBeDefined()
      expect(strategy.insertReturning).toBeTypeOf('function')
      expect(strategy.updateReturning).toBeTypeOf('function')
    })

    it("should return sqlite strategy for 'sqlite' dialect", () => {
      const strategy = getReturningStrategy('sqlite')
      expect(strategy).toBeDefined()
      expect(strategy.insertReturning).toBeTypeOf('function')
      expect(strategy.updateReturning).toBeTypeOf('function')
    })

    it("should return mysql strategy for 'mysql' dialect", () => {
      const strategy = getReturningStrategy('mysql')
      expect(strategy).toBeDefined()
      expect(strategy.insertReturning).toBeTypeOf('function')
      expect(strategy.updateReturning).toBeTypeOf('function')
    })

    it('should have strategies for all supported dialects', () => {
      // TypeScript enforces valid dialects at compile time
      // This test verifies all dialects return defined strategies
      const dialects = ['pg', 'sqlite', 'mysql'] as const
      dialects.forEach((dialect) => {
        expect(getReturningStrategy(dialect)).toBeDefined()
      })
    })
  })

  describe('strategy consistency', () => {
    it('sqlite strategy should be same as pg strategy (SQLite supports RETURNING)', () => {
      const pgStrategy = getReturningStrategy('pg')
      const sqliteStrategy = getReturningStrategy('sqlite')
      expect(pgStrategy.insertReturning).toBe(sqliteStrategy.insertReturning)
      expect(pgStrategy.updateReturning).toBe(sqliteStrategy.updateReturning)
    })

    it('mysql strategy should be different from pg strategy', () => {
      const pgStrategy = getReturningStrategy('pg')
      const mysqlStrategy = getReturningStrategy('mysql')
      expect(pgStrategy.insertReturning).not.toBe(mysqlStrategy.insertReturning)
      expect(pgStrategy.updateReturning).not.toBe(mysqlStrategy.updateReturning)
    })
  })
})
