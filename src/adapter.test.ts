import { describe, it, expect } from "vitest"

// Since adapter utility functions are not exported, we'll test them via the
// exported interface where possible, and also create unit tests for the logic
// patterns they implement.

describe("adapter utilities", () => {
  describe("getAffectedRows logic", () => {
    // Testing the same logic as getAffectedRows
    const getAffectedRows = (raw: unknown): number => {
      if (typeof raw !== "object" || raw === null) return 0
      const result = raw as Record<string, unknown>
      if (typeof result.affectedRows === "number") return result.affectedRows
      if (typeof result.rowCount === "number") return result.rowCount
      if (typeof result.changes === "number") return result.changes
      return 0
    }

    it("should return 0 for null", () => {
      expect(getAffectedRows(null)).toBe(0)
    })

    it("should return 0 for non-object", () => {
      expect(getAffectedRows("string")).toBe(0)
      expect(getAffectedRows(123)).toBe(0)
      expect(getAffectedRows(undefined)).toBe(0)
    })

    it("should extract affectedRows (MySQL)", () => {
      expect(getAffectedRows({ affectedRows: 5 })).toBe(5)
    })

    it("should extract rowCount (PostgreSQL)", () => {
      expect(getAffectedRows({ rowCount: 3 })).toBe(3)
    })

    it("should extract changes (SQLite)", () => {
      expect(getAffectedRows({ changes: 7 })).toBe(7)
    })

    it("should return 0 if no known property exists", () => {
      expect(getAffectedRows({ otherProp: 10 })).toBe(0)
    })

    it("should return 0 if property is not a number", () => {
      expect(getAffectedRows({ affectedRows: "5" })).toBe(0)
      expect(getAffectedRows({ rowCount: null })).toBe(0)
    })

    it("should prioritize affectedRows over others", () => {
      expect(getAffectedRows({ affectedRows: 1, rowCount: 2, changes: 3 })).toBe(1)
    })
  })

  describe("isPlainObjectOrArray logic", () => {
    const isPlainObjectOrArray = (
      value: unknown,
    ): value is Record<string, unknown> | unknown[] =>
      value !== null &&
      typeof value === "object" &&
      (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)

    it("should return true for plain object", () => {
      expect(isPlainObjectOrArray({})).toBe(true)
      expect(isPlainObjectOrArray({ a: 1 })).toBe(true)
    })

    it("should return true for array", () => {
      expect(isPlainObjectOrArray([])).toBe(true)
      expect(isPlainObjectOrArray([1, 2, 3])).toBe(true)
    })

    it("should return false for null", () => {
      expect(isPlainObjectOrArray(null)).toBe(false)
    })

    it("should return false for primitives", () => {
      expect(isPlainObjectOrArray("string")).toBe(false)
      expect(isPlainObjectOrArray(123)).toBe(false)
      expect(isPlainObjectOrArray(true)).toBe(false)
    })

    it("should return false for class instances", () => {
      class MyClass {}
      expect(isPlainObjectOrArray(new MyClass())).toBe(false)
    })

    it("should return true for Object.create(Object.prototype)", () => {
      expect(isPlainObjectOrArray(Object.create(Object.prototype))).toBe(true)
    })
  })

  describe("safeJsonStringify logic", () => {
    const safeJsonStringify = (
      value: Record<string, unknown> | unknown[],
    ): string => {
      const seen = new WeakSet()
      return JSON.stringify(value, (_, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return undefined
          seen.add(v)
        }
        return v
      })
    }

    it("should stringify plain object", () => {
      expect(safeJsonStringify({ a: 1, b: "test" })).toBe('{"a":1,"b":"test"}')
    })

    it("should stringify array", () => {
      expect(safeJsonStringify([1, 2, 3])).toBe("[1,2,3]")
    })

    it("should handle nested objects", () => {
      expect(safeJsonStringify({ outer: { inner: "value" } })).toBe(
        '{"outer":{"inner":"value"}}',
      )
    })

    it("should handle circular references by omitting them", () => {
      const obj: Record<string, unknown> = { a: 1 }
      obj.self = obj
      const result = safeJsonStringify(obj)
      expect(result).toBe('{"a":1}')
    })

    it("should handle deeply nested circular references", () => {
      const obj: Record<string, unknown> = {
        level1: {
          level2: {},
        },
      }
      ;(obj.level1 as Record<string, unknown>).level2 = obj
      const result = safeJsonStringify(obj)
      expect(JSON.parse(result)).toEqual({ level1: {} })
    })
  })

  describe("toSqlData logic", () => {
    type Primitive =
      | null
      | string
      | number
      | bigint
      | boolean
      | Date
      | Int8Array
      | Uint8Array
    type SqlData = Record<string, Primitive | undefined>

    const isPlainObjectOrArray = (
      value: unknown,
    ): value is Record<string, unknown> | unknown[] =>
      value !== null &&
      typeof value === "object" &&
      (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)

    const safeJsonStringify = (
      value: Record<string, unknown> | unknown[],
    ): string => {
      const seen = new WeakSet()
      return JSON.stringify(value, (_, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return undefined
          seen.add(v)
        }
        return v
      })
    }

    const toSqlData = (data: Record<string, unknown>): SqlData => {
      const result: SqlData = {}
      for (const [key, value] of Object.entries(data)) {
        if (
          value === null ||
          value === undefined ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "bigint" ||
          typeof value === "boolean" ||
          value instanceof Date ||
          value instanceof Int8Array ||
          value instanceof Uint8Array
        ) {
          result[key] = value as Primitive | undefined
        } else if (isPlainObjectOrArray(value)) {
          result[key] = safeJsonStringify(value)
        } else {
          result[key] = String(value)
        }
      }
      return result
    }

    it("should pass through null", () => {
      expect(toSqlData({ field: null })).toEqual({ field: null })
    })

    it("should pass through undefined", () => {
      expect(toSqlData({ field: undefined })).toEqual({ field: undefined })
    })

    it("should pass through string", () => {
      expect(toSqlData({ name: "test" })).toEqual({ name: "test" })
    })

    it("should pass through number", () => {
      expect(toSqlData({ count: 42 })).toEqual({ count: 42 })
    })

    it("should pass through bigint", () => {
      expect(toSqlData({ big: BigInt(123) })).toEqual({ big: BigInt(123) })
    })

    it("should pass through boolean", () => {
      expect(toSqlData({ active: true })).toEqual({ active: true })
    })

    it("should pass through Date", () => {
      const date = new Date("2024-01-15")
      expect(toSqlData({ created: date })).toEqual({ created: date })
    })

    it("should pass through Uint8Array", () => {
      const bytes = new Uint8Array([1, 2, 3])
      expect(toSqlData({ data: bytes })).toEqual({ data: bytes })
    })

    it("should convert plain object to JSON string", () => {
      expect(toSqlData({ metadata: { key: "value" } })).toEqual({
        metadata: '{"key":"value"}',
      })
    })

    it("should convert array to JSON string", () => {
      expect(toSqlData({ tags: ["a", "b", "c"] })).toEqual({
        tags: '["a","b","c"]',
      })
    })

    it("should convert other types to string", () => {
      const symbol = Symbol("test")
      expect(toSqlData({ sym: symbol })).toEqual({
        sym: String(symbol),
      })
    })

    it("should handle multiple fields of different types", () => {
      const result = toSqlData({
        name: "test",
        age: 25,
        active: true,
        metadata: { key: "value" },
      })
      expect(result).toEqual({
        name: "test",
        age: 25,
        active: true,
        metadata: '{"key":"value"}',
      })
    })
  })

  describe("toWhereConditions logic", () => {
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

    const toWhereConditions = (
      where: Where[],
      getFieldName: (opts: { model: string; field: string }) => string,
      model: string,
    ): WhereCondition[] =>
      where.map((w) => ({
        field: getFieldName({ model, field: w.field }),
        value: w.value,
        operator: w.operator ?? "eq",
        connector: w.connector ?? "AND",
      }))

    const simpleGetFieldName = ({ field }: { model: string; field: string }) =>
      field

    it("should convert simple where condition", () => {
      const result = toWhereConditions(
        [{ field: "id", value: 1 }],
        simpleGetFieldName,
        "users",
      )
      expect(result).toEqual([
        { field: "id", value: 1, operator: "eq", connector: "AND" },
      ])
    })

    it("should use provided operator", () => {
      const result = toWhereConditions(
        [{ field: "age", value: 18, operator: "gte" }],
        simpleGetFieldName,
        "users",
      )
      expect(result).toEqual([
        { field: "age", value: 18, operator: "gte", connector: "AND" },
      ])
    })

    it("should use provided connector", () => {
      const result = toWhereConditions(
        [{ field: "status", value: "active", connector: "OR" }],
        simpleGetFieldName,
        "users",
      )
      expect(result).toEqual([
        { field: "status", value: "active", operator: "eq", connector: "OR" },
      ])
    })

    it("should use custom getFieldName function", () => {
      const prefixedGetFieldName = ({
        model,
        field,
      }: {
        model: string
        field: string
      }) => `${model}_${field}`

      const result = toWhereConditions(
        [{ field: "id", value: 1 }],
        prefixedGetFieldName,
        "users",
      )
      expect(result).toEqual([
        { field: "users_id", value: 1, operator: "eq", connector: "AND" },
      ])
    })

    it("should handle multiple conditions", () => {
      const result = toWhereConditions(
        [
          { field: "status", value: "active" },
          { field: "role", value: "admin", operator: "eq", connector: "OR" },
        ],
        simpleGetFieldName,
        "users",
      )
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        field: "status",
        value: "active",
        operator: "eq",
        connector: "AND",
      })
      expect(result[1]).toEqual({
        field: "role",
        value: "admin",
        operator: "eq",
        connector: "OR",
      })
    })
  })
})

describe("effectSqlAdapter factory", () => {
  it("should be importable", async () => {
    const module = await import("./adapter.js")
    expect(module.effectSqlAdapter).toBeTypeOf("function")
  })
})
