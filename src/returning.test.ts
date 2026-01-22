import { describe, it, expect } from "vitest"
import { getReturningStrategy } from "./returning.js"

describe("getReturningStrategy", () => {
  describe("dialect selection", () => {
    it("should return pg strategy for 'pg' dialect", () => {
      const strategy = getReturningStrategy("pg")
      expect(strategy).toBeDefined()
      expect(strategy.insertReturning).toBeTypeOf("function")
      expect(strategy.updateReturning).toBeTypeOf("function")
    })

    it("should return sqlite strategy for 'sqlite' dialect", () => {
      const strategy = getReturningStrategy("sqlite")
      expect(strategy).toBeDefined()
      expect(strategy.insertReturning).toBeTypeOf("function")
      expect(strategy.updateReturning).toBeTypeOf("function")
    })

    it("should return mysql strategy for 'mysql' dialect", () => {
      const strategy = getReturningStrategy("mysql")
      expect(strategy).toBeDefined()
      expect(strategy.insertReturning).toBeTypeOf("function")
      expect(strategy.updateReturning).toBeTypeOf("function")
    })

    it("should throw error for unknown dialect", () => {
      expect(() => {
        getReturningStrategy("unknown" as "pg")
      }).toThrow("Unknown dialect: unknown")
    })
  })

  describe("strategy consistency", () => {
    it("sqlite strategy should be same as pg strategy (SQLite supports RETURNING)", () => {
      const pgStrategy = getReturningStrategy("pg")
      const sqliteStrategy = getReturningStrategy("sqlite")
      expect(pgStrategy.insertReturning).toBe(sqliteStrategy.insertReturning)
      expect(pgStrategy.updateReturning).toBe(sqliteStrategy.updateReturning)
    })

    it("mysql strategy should be different from pg strategy", () => {
      const pgStrategy = getReturningStrategy("pg")
      const mysqlStrategy = getReturningStrategy("mysql")
      expect(pgStrategy.insertReturning).not.toBe(mysqlStrategy.insertReturning)
      expect(pgStrategy.updateReturning).not.toBe(mysqlStrategy.updateReturning)
    })
  })
})
