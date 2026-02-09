import { describe, it, expect } from 'vitest'
import { getAffectedRows, convertToSqlValue, toSqlData } from './transforms.js'

describe('getAffectedRows', () => {
  it('should return 0 for null', () => {
    expect(getAffectedRows(null)).toBe(0)
  })

  it('should return 0 for non-object', () => {
    expect(getAffectedRows('string')).toBe(0)
    expect(getAffectedRows(123)).toBe(0)
    expect(getAffectedRows(undefined)).toBe(0)
  })

  it('should extract affectedRows (MySQL)', () => {
    expect(getAffectedRows({ affectedRows: 5 })).toBe(5)
  })

  it('should extract rowCount (PostgreSQL)', () => {
    expect(getAffectedRows({ rowCount: 3 })).toBe(3)
  })

  it('should extract changes (SQLite)', () => {
    expect(getAffectedRows({ changes: 7 })).toBe(7)
  })

  it('should return 0 if no known property exists', () => {
    expect(getAffectedRows({ otherProp: 10 })).toBe(0)
  })

  it('should return 0 if property is not a number', () => {
    expect(getAffectedRows({ affectedRows: '5' })).toBe(0)
    expect(getAffectedRows({ rowCount: null })).toBe(0)
  })

  it('should prioritize affectedRows over others', () => {
    expect(getAffectedRows({ affectedRows: 1, rowCount: 2, changes: 3 })).toBe(1)
  })
})

describe('convertToSqlValue', () => {
  it('should pass through null', () => {
    expect(convertToSqlValue(null)).toBe(null)
  })

  it('should pass through undefined', () => {
    expect(convertToSqlValue(undefined)).toBe(undefined)
  })

  it('should pass through string', () => {
    expect(convertToSqlValue('test')).toBe('test')
  })

  it('should pass through number', () => {
    expect(convertToSqlValue(42)).toBe(42)
    expect(convertToSqlValue(3.14)).toBe(3.14)
    expect(convertToSqlValue(-100)).toBe(-100)
  })

  it('should pass through bigint', () => {
    const big = BigInt(9007199254740991)
    expect(convertToSqlValue(big)).toBe(big)
  })

  it('should convert boolean to 0/1', () => {
    expect(convertToSqlValue(true)).toBe(1)
    expect(convertToSqlValue(false)).toBe(0)
  })

  it('should convert Date to ISO string', () => {
    const date = new Date('2024-01-15T10:00:00Z')
    expect(convertToSqlValue(date)).toBe('2024-01-15T10:00:00.000Z')
  })

  it('should pass through Uint8Array', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(convertToSqlValue(bytes)).toBe(bytes)
  })

  it('should pass through Int8Array', () => {
    const bytes = new Int8Array([1, -2, 3])
    expect(convertToSqlValue(bytes)).toBe(bytes)
  })

  it('should convert plain object to JSON string', () => {
    expect(convertToSqlValue({ key: 'value' })).toBe('{"key":"value"}')
  })

  it('should convert array to JSON string', () => {
    expect(convertToSqlValue([1, 2, 3])).toBe('[1,2,3]')
  })

  it('should convert nested object to JSON string', () => {
    expect(convertToSqlValue({ outer: { inner: 'value' } })).toBe('{"outer":{"inner":"value"}}')
  })

  it('should handle circular references in objects', () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    expect(convertToSqlValue(obj)).toBe('{"a":1}')
  })

  it('should convert class instance to string', () => {
    class MyClass {
      toString() {
        return 'MyClass instance'
      }
    }
    expect(convertToSqlValue(new MyClass())).toBe('MyClass instance')
  })

  it('should convert Symbol to string', () => {
    const sym = Symbol('test')
    expect(convertToSqlValue(sym)).toBe('Symbol(test)')
  })

  it('should convert function to string', () => {
    const fn = () => 'hello'
    expect(convertToSqlValue(fn)).toContain('hello')
  })
})

describe('toSqlData', () => {
  it('should pass through null', () => {
    expect(toSqlData({ field: null })).toEqual({ field: null })
  })

  it('should pass through undefined', () => {
    expect(toSqlData({ field: undefined })).toEqual({ field: undefined })
  })

  it('should pass through string', () => {
    expect(toSqlData({ name: 'test' })).toEqual({ name: 'test' })
  })

  it('should pass through number', () => {
    expect(toSqlData({ count: 42 })).toEqual({ count: 42 })
  })

  it('should pass through bigint', () => {
    expect(toSqlData({ big: BigInt(123) })).toEqual({ big: BigInt(123) })
  })

  it('should convert boolean to 0/1', () => {
    expect(toSqlData({ active: true })).toEqual({ active: 1 })
    expect(toSqlData({ active: false })).toEqual({ active: 0 })
  })

  it('should convert Date to ISO string', () => {
    const date = new Date('2024-01-15T10:00:00Z')
    expect(toSqlData({ created: date })).toEqual({ created: '2024-01-15T10:00:00.000Z' })
  })

  it('should pass through Uint8Array', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(toSqlData({ data: bytes })).toEqual({ data: bytes })
  })

  it('should convert plain object to JSON string', () => {
    expect(toSqlData({ metadata: { key: 'value' } })).toEqual({
      metadata: '{"key":"value"}',
    })
  })

  it('should convert array to JSON string', () => {
    expect(toSqlData({ tags: ['a', 'b', 'c'] })).toEqual({
      tags: '["a","b","c"]',
    })
  })

  it('should convert other types to string', () => {
    const symbol = Symbol('test')
    expect(toSqlData({ sym: symbol })).toEqual({
      sym: String(symbol),
    })
  })

  it('should handle multiple fields of different types', () => {
    const result = toSqlData({
      name: 'test',
      age: 25,
      active: true,
      metadata: { key: 'value' },
    })
    expect(result).toEqual({
      name: 'test',
      age: 25,
      active: 1,
      metadata: '{"key":"value"}',
    })
  })
})
