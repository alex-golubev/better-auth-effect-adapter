import { describe, it, expect } from 'vitest'
import { AdapterError, ConstraintViolationError, ConnectionError, mapSqlError } from './errors.js'

describe('Error classes', () => {
  describe('AdapterError', () => {
    it('should create error with message', () => {
      const error = new AdapterError({ message: 'test error' })
      expect(error.message).toBe('test error')
      expect(error._tag).toBe('AdapterError')
    })

    it('should create error with original cause', () => {
      const cause = new Error('original')
      const error = new AdapterError({
        message: 'test error',
        originalCause: cause,
      })
      expect(error.originalCause).toBe(cause)
    })
  })

  describe('ConstraintViolationError', () => {
    it('should create error with message', () => {
      const error = new ConstraintViolationError({ message: 'constraint error' })
      expect(error.message).toBe('constraint error')
      expect(error._tag).toBe('ConstraintViolationError')
    })

    it('should create error with constraint type', () => {
      const error = new ConstraintViolationError({
        message: 'unique constraint',
        constraint: 'unique',
      })
      expect(error.constraint).toBe('unique')
    })
  })

  describe('ConnectionError', () => {
    it('should create error with message', () => {
      const error = new ConnectionError({ message: 'connection failed' })
      expect(error.message).toBe('connection failed')
      expect(error._tag).toBe('ConnectionError')
    })
  })
})

describe('mapSqlError', () => {
  const createSqlError = (message: string) => ({
    _tag: 'SqlError' as const,
    message,
  })

  describe('non-SqlError handling', () => {
    it('should map regular Error to AdapterError', () => {
      const error = new Error('regular error')
      const result = mapSqlError(error)
      expect(result._tag).toBe('AdapterError')
      expect(result.message).toBe('regular error')
    })

    it("should map unknown value to AdapterError with 'Unknown error'", () => {
      const result = mapSqlError('string error')
      expect(result._tag).toBe('AdapterError')
      expect(result.message).toBe('Unknown error')
    })

    it('should map null to AdapterError', () => {
      const result = mapSqlError(null)
      expect(result._tag).toBe('AdapterError')
      expect(result.message).toBe('Unknown error')
    })
  })

  describe('unique constraint violations', () => {
    it("should detect 'UNIQUE constraint' (SQLite)", () => {
      const error = createSqlError('UNIQUE constraint failed: users.email')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConstraintViolationError')
      expect((result as ConstraintViolationError).constraint).toBe('unique')
    })

    it("should detect 'duplicate key' (PostgreSQL)", () => {
      const error = createSqlError('duplicate key value violates unique constraint')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConstraintViolationError')
      expect((result as ConstraintViolationError).constraint).toBe('unique')
    })

    it("should detect 'Duplicate entry' (MySQL)", () => {
      const error = createSqlError("Duplicate entry 'test@example.com' for key 'email'")
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConstraintViolationError')
      expect((result as ConstraintViolationError).constraint).toBe('unique')
    })

    it("should detect 'violates unique constraint' (PostgreSQL)", () => {
      const error = createSqlError("violates unique constraint 'users_email_key'")
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConstraintViolationError')
      expect((result as ConstraintViolationError).constraint).toBe('unique')
    })
  })

  describe('foreign key violations', () => {
    it("should detect 'FOREIGN KEY constraint' (SQLite)", () => {
      const error = createSqlError('FOREIGN KEY constraint failed')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConstraintViolationError')
      expect((result as ConstraintViolationError).constraint).toBe('foreign_key')
    })

    it("should detect 'foreign key constraint' (PostgreSQL/MySQL)", () => {
      const error = createSqlError('foreign key constraint violation')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConstraintViolationError')
      expect((result as ConstraintViolationError).constraint).toBe('foreign_key')
    })

    it("should detect 'violates foreign key'", () => {
      const error = createSqlError("violates foreign key constraint 'fk_user_id'")
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConstraintViolationError')
      expect((result as ConstraintViolationError).constraint).toBe('foreign_key')
    })
  })

  describe('connection errors', () => {
    it("should detect 'ECONNREFUSED'", () => {
      const error = createSqlError('connect ECONNREFUSED 127.0.0.1:5432')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConnectionError')
    })

    it("should detect 'ETIMEDOUT'", () => {
      const error = createSqlError('connect ETIMEDOUT')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConnectionError')
    })

    it("should detect 'ENOTFOUND'", () => {
      const error = createSqlError('getaddrinfo ENOTFOUND db.example.com')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConnectionError')
    })

    it("should detect 'connection refused'", () => {
      const error = createSqlError('connection refused by server')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConnectionError')
    })

    it("should detect 'connection timeout'", () => {
      const error = createSqlError('connection timeout after 30000ms')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConnectionError')
    })

    it("should detect 'Connection lost'", () => {
      const error = createSqlError('Connection lost: The server closed the connection')
      const result = mapSqlError(error)
      expect(result._tag).toBe('ConnectionError')
    })
  })

  describe('generic SQL errors', () => {
    it('should map unknown SqlError to AdapterError', () => {
      const error = createSqlError('syntax error at position 42')
      const result = mapSqlError(error)
      expect(result._tag).toBe('AdapterError')
      expect(result.message).toBe('syntax error at position 42')
    })

    it('should handle SqlError with undefined message', () => {
      const error = { _tag: 'SqlError' as const, message: undefined }
      const result = mapSqlError(error)
      expect(result._tag).toBe('AdapterError')
      expect(result.message).toBe('Unknown SQL error')
    })
  })
})
