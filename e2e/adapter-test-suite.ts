import { expect } from 'vitest'
import { createTestSuite } from '@better-auth/test-utils/adapter'

interface UserRecord {
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: string
  updatedAt: string
}

interface SessionRecord {
  id: string
  userId: string
  token: string
  expiresAt: string
  createdAt: string
  updatedAt: string
}

export const adapterTestSuite = createTestSuite(
  'Adapter CRUD',
  {},
  ({ adapter, generate, insertRandom, cleanup, tryCatch }) => ({
    CREATE_MODEL: async () => {
      const userData = await generate('user')
      const res = (await adapter.create({ model: 'user', data: userData })) as UserRecord
      expect(res.name).toBe(userData.name)
      expect(res.email).toBe(userData.email)
      await cleanup()
    },

    CREATE_MODEL_SHOULD_ALWAYS_RETURN_AN_ID: async () => {
      const res = (await adapter.create({
        model: 'user',
        data: {
          name: 'test-name-without-id',
          email: `no-id-${Date.now()}@email.com`,
        },
      })) as UserRecord
      expect(res).toHaveProperty('id')
      expect(typeof res.id).toBe('string')
      await cleanup()
    },

    FIND_MODEL: async () => {
      const [user] = await insertRandom('user')
      const found = (await adapter.findOne({
        model: 'user',
        where: [{ field: 'id', value: user.id }],
      })) as UserRecord | null
      expect(found).not.toBeNull()
      expect(found!.name).toBe(user.name)
      expect(found!.email).toBe(user.email)
      await cleanup()
    },

    FIND_MODEL_WITHOUT_ID: async () => {
      const [user] = await insertRandom('user')
      const found = (await adapter.findOne({
        model: 'user',
        where: [{ field: 'email', value: user.email }],
      })) as UserRecord | null
      expect(found).not.toBeNull()
      expect(found!.name).toBe(user.name)
      await cleanup()
    },

    FIND_MODEL_WITH_SELECT: async () => {
      const [user] = await insertRandom('user')
      const found = await adapter.findOne({
        model: 'user',
        where: [{ field: 'id', value: user.id }],
        select: ['email'],
      })
      expect(found).toEqual({ email: user.email })
      await cleanup()
    },

    FIND_MODEL_WITH_MODIFIED_FIELD_NAME: {
      migrateBetterAuth: { user: { fields: { email: 'email_address' } } },
      test: async () => {
        const email = `modified-field-${Date.now()}@email.com`
        const res = (await adapter.create({
          model: 'user',
          data: { name: 'modified-field-user', email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
        })) as UserRecord
        expect(res.email).toBe(email)

        const found = (await adapter.findOne({
          model: 'user',
          where: [{ field: 'email', value: email }],
        })) as UserRecord | null
        expect(found).not.toBeNull()
        expect(found!.email).toBe(email)
        await cleanup()
      },
    },

    UPDATE_MODEL: async () => {
      const [user] = await insertRandom('user')
      const newEmail = `updated-${Date.now()}@email.com`
      const updated = (await adapter.update({
        model: 'user',
        where: [{ field: 'id', value: user.id }],
        update: { email: newEmail },
      })) as UserRecord | null
      expect(updated).not.toBeNull()
      expect(updated!.email).toBe(newEmail)
      expect(updated!.name).toBe(user.name)
      await cleanup()
    },

    SHOULD_FIND_MANY: async () => {
      await insertRandom('user', 3)
      const results = await adapter.findMany({ model: 'user' })
      expect(results.length).toBeGreaterThanOrEqual(3)
      await cleanup()
    },

    SHOULD_FIND_MANY_WITH_WHERE: async () => {
      const [user] = await insertRandom('user')
      const results = await adapter.findMany({
        model: 'user',
        where: [{ field: 'id', value: user.id }],
      })
      expect(results.length).toBe(1)
      await cleanup()
    },

    SHOULD_FIND_MANY_WITH_IN_OPERATOR: async () => {
      const users = await insertRandom('user', 3)
      const ids = users.map(([u]) => u.id)
      const results = await adapter.findMany({
        model: 'user',
        where: [{ field: 'id', operator: 'in', value: ids }],
      })
      expect(results.length).toBe(3)
      await cleanup()
    },

    SHOULD_FIND_MANY_WITH_NOT_IN_OPERATOR: async () => {
      const users = await insertRandom('user', 3)
      const excludeIds = [users[0]![0].id]
      const all = await adapter.findMany({ model: 'user' })
      const results = await adapter.findMany({
        model: 'user',
        where: [{ field: 'id', operator: 'not_in', value: excludeIds }],
      })
      expect(results.length).toBe(all.length - 1)
      await cleanup()
    },

    SHOULD_WORK_WITH_REFERENCE_FIELDS: async () => {
      const [user, session] = await insertRandom('session')
      const found = (await adapter.findOne({
        model: 'session',
        where: [{ field: 'userId', value: user.id }],
      })) as SessionRecord | null
      expect(found).not.toBeNull()
      expect(found!.userId).toBe(user.id)

      const byToken = (await adapter.findOne({
        model: 'session',
        where: [{ field: 'token', value: session.token }],
      })) as SessionRecord | null
      expect(byToken).not.toBeNull()
      expect(byToken!.userId).toBe(user.id)
      await cleanup()
    },

    SHOULD_FIND_MANY_WITH_SORT_BY: async () => {
      await insertRandom('user', 3)
      const asc = (await adapter.findMany({
        model: 'user',
        sortBy: { field: 'name', direction: 'asc' },
      })) as UserRecord[]
      const desc = (await adapter.findMany({
        model: 'user',
        sortBy: { field: 'name', direction: 'desc' },
      })) as UserRecord[]
      expect(asc[0]!.name).toBe(desc[desc.length - 1]!.name)
      await cleanup()
    },

    SHOULD_FIND_MANY_WITH_LIMIT: async () => {
      await insertRandom('user', 3)
      const results = await adapter.findMany({ model: 'user', limit: 1 })
      expect(results.length).toBe(1)
      await cleanup()
    },

    SHOULD_FIND_MANY_WITH_OFFSET: async () => {
      await insertRandom('user', 5)
      const all = await adapter.findMany({ model: 'user' })
      const withOffset = await adapter.findMany({ model: 'user', offset: 2 })
      expect(withOffset.length).toBe(all.length - 2)
      await cleanup()
    },

    SHOULD_UPDATE_WITH_MULTIPLE_WHERE: async () => {
      const [user] = await insertRandom('user')
      const newEmail = `multi-where-${Date.now()}@email.com`
      await adapter.updateMany({
        model: 'user',
        where: [
          { field: 'name', value: user.name },
          { field: 'email', value: user.email },
        ],
        update: { email: newEmail },
      })
      const found = (await adapter.findOne({
        model: 'user',
        where: [{ field: 'email', value: newEmail }],
      })) as UserRecord | null
      expect(found).not.toBeNull()
      expect(found!.name).toBe(user.name)
      expect(found!.email).toBe(newEmail)
      await cleanup()
    },

    DELETE_MODEL: async () => {
      const [user] = await insertRandom('user')
      await adapter.delete({ model: 'user', where: [{ field: 'id', value: user.id }] })
      const found = await adapter.findOne({ model: 'user', where: [{ field: 'id', value: user.id }] })
      expect(found).toBeNull()
      await cleanup()
    },

    SHOULD_DELETE_MANY: async () => {
      const marker = `to-be-deleted-${Date.now()}`
      for (let i = 0; i < 3; i++) {
        await adapter.create({
          model: 'user',
          data: {
            name: marker,
            email: `${marker}-${i}@test.com`,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
      }
      const before = await adapter.findMany({
        model: 'user',
        where: [{ field: 'name', value: marker }],
      })
      expect(before.length).toBe(3)

      await adapter.deleteMany({
        model: 'user',
        where: [{ field: 'name', value: marker }],
      })
      const after = await adapter.findMany({
        model: 'user',
        where: [{ field: 'name', value: marker }],
      })
      expect(after.length).toBe(0)
      await cleanup()
    },

    SHOULD_NOT_THROW_ON_DELETE_RECORD_NOT_FOUND: async () => {
      await adapter.delete({ model: 'user', where: [{ field: 'id', value: 'non-existent-id-999' }] })
    },

    SHOULD_NOT_THROW_ON_RECORD_NOT_FOUND: async () => {
      const result = await adapter.findOne({
        model: 'user',
        where: [{ field: 'id', value: 'non-existent-id-999' }],
      })
      expect(result).toBeNull()
    },

    SHOULD_FIND_MANY_WITH_CONTAINS_OPERATOR: async () => {
      const marker = `contains-${Date.now()}`
      await adapter.create({
        model: 'user',
        data: {
          name: `prefix-${marker}-suffix`,
          email: `${marker}@test.com`,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      })
      const results = await adapter.findMany({
        model: 'user',
        where: [{ field: 'name', operator: 'contains', value: marker }],
      })
      expect(results.length).toBe(1)
      await cleanup()
    },

    SHOULD_SEARCH_WITH_STARTS_WITH: async () => {
      const marker = `sw-${Date.now()}`
      for (let i = 0; i < 3; i++) {
        await adapter.create({
          model: 'user',
          data: {
            name: `${marker}-user${i}`,
            email: `${marker}-${i}@test.com`,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
      }
      const results = await adapter.findMany({
        model: 'user',
        where: [{ field: 'name', operator: 'starts_with', value: marker }],
      })
      expect(results.length).toBeGreaterThanOrEqual(3)
      await cleanup()
    },

    SHOULD_SEARCH_WITH_ENDS_WITH: async () => {
      const marker = `ew-${Date.now()}`
      await adapter.create({
        model: 'user',
        data: {
          name: `user-${marker}`,
          email: `${marker}@test.com`,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      })
      const results = await adapter.findMany({
        model: 'user',
        where: [{ field: 'name', operator: 'ends_with', value: marker }],
      })
      expect(results.length).toBe(1)
      await cleanup()
    },

    SHOULD_PREFER_GENERATE_ID_IF_PROVIDED: {
      migrateBetterAuth: { advanced: { database: { generateId: () => 'mocked-id' } } },
      test: async () => {
        const res = (await adapter.create({
          model: 'user',
          data: {
            name: 'custom-id-user',
            email: `custom-id-${Date.now()}@test.com`,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })) as UserRecord
        expect(res.id).toBe('mocked-id')
        await cleanup()
      },
    },

    SHOULD_ROLLBACK_FAILING_TRANSACTION: async ({ skip }) => {
      const transaction = adapter.options?.adapterConfig?.transaction
      if (!transaction) {
        skip('Adapter does not support transactions')
        return
      }

      const email1 = `tx-rollback-1-${Date.now()}@test.com`
      const email2 = `tx-rollback-2-${Date.now()}@test.com`

      const result = await tryCatch(
        transaction(async (txAdapter) => {
          await txAdapter.create({
            model: 'user',
            data: {
              name: 'tx-user1',
              email: email1,
              emailVerified: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          })
          throw new Error('Simulated failure')
        }),
      )

      expect(result.error).not.toBeNull()
      expect(result.error!.message).toBe('Simulated failure')

      const found = await adapter.findMany({
        model: 'user',
        where: [
          { field: 'email', value: email1, connector: 'OR' },
          { field: 'email', value: email2, connector: 'OR' },
        ],
      })
      expect(found).toEqual([])
      await cleanup()
    },

    SHOULD_RETURN_TRANSACTION_RESULT: async ({ skip }) => {
      const transaction = adapter.options?.adapterConfig?.transaction
      if (!transaction) {
        skip('Adapter does not support transactions')
        return
      }

      const email = `tx-result-${Date.now()}@test.com`
      const txResult = await transaction(async (txAdapter) => {
        const created = (await txAdapter.create({
          model: 'user',
          data: {
            name: 'tx-result-user',
            email,
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })) as UserRecord
        return created.email
      })

      expect(txResult).toBe(email)
      await cleanup()
    },

    SHOULD_FIND_MANY_WITH_CONNECTORS: async () => {
      const marker = `conn-${Date.now()}`
      const email1 = `${marker}-1@test.com`
      const email2 = `${marker}-2@test.com`

      await adapter.create({
        model: 'user',
        data: { name: `${marker}-user1`, email: email1, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      })
      await adapter.create({
        model: 'user',
        data: { name: `${marker}-user2`, email: email2, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      })

      const andResults = await adapter.findMany({
        model: 'user',
        where: [
          { field: 'name', value: `${marker}-user2`, connector: 'AND' },
          { field: 'email', value: email2, connector: 'AND' },
        ],
      })
      expect(andResults.length).toBe(1)

      const orResults = await adapter.findMany({
        model: 'user',
        where: [
          { field: 'name', value: `${marker}-user1`, connector: 'OR' },
          { field: 'name', value: `${marker}-user2`, connector: 'OR' },
        ],
      })
      expect(orResults.length).toBe(2)
      await cleanup()
    },

    SHOULD_HANDLE_IN_FILTER_WITH_BOOLEAN_VALUES: async () => {
      const marker = `bool-in-${Date.now()}`
      await adapter.create({
        model: 'user',
        data: { name: 'bool-true', email: `${marker}-true@test.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      })
      await adapter.create({
        model: 'user',
        data: { name: 'bool-false', email: `${marker}-false@test.com`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
      })

      const results = (await adapter.findMany({
        model: 'user',
        where: [{ field: 'emailVerified', operator: 'in', value: [true] as unknown as number[] }],
        limit: 100,
      })) as UserRecord[]
      expect(results.some((r) => r.email === `${marker}-true@test.com`)).toBe(true)
      expect(results.some((r) => r.email === `${marker}-false@test.com`)).toBe(false)
      await cleanup()
    },

    SHOULD_HANDLE_IN_FILTER_WITH_DATE_VALUES: async () => {
      const targetDate = new Date('2026-02-12T10:00:00.000Z')
      const email = `date-in-${Date.now()}@test.com`
      await adapter.create({
        model: 'user',
        data: { name: 'date-user', email, emailVerified: true, createdAt: targetDate, updatedAt: new Date() },
      })

      const results = (await adapter.findMany({
        model: 'user',
        where: [{ field: 'createdAt', operator: 'in', value: [targetDate] as unknown as string[] }],
        limit: 100,
      })) as UserRecord[]
      expect(results.some((r) => r.email === email)).toBe(true)
      await cleanup()
    },

    UPDATE_MANY_SHOULD_RETURN_COUNT: async () => {
      const marker = `update-count-${Date.now()}`
      for (let i = 0; i < 3; i++) {
        await adapter.create({
          model: 'user',
          data: { name: marker, email: `${marker}-${i}@test.com`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
        })
      }
      const count = await adapter.updateMany({
        model: 'user',
        where: [{ field: 'name', value: marker }],
        update: { emailVerified: true },
      })
      expect(count).toBe(3)
      await cleanup()
    },

    DELETE_MANY_SHOULD_RETURN_COUNT: async () => {
      const marker = `delete-count-${Date.now()}`
      for (let i = 0; i < 3; i++) {
        await adapter.create({
          model: 'user',
          data: { name: marker, email: `${marker}-${i}@test.com`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() },
        })
      }
      const count = await adapter.deleteMany({
        model: 'user',
        where: [{ field: 'name', value: marker }],
      })
      expect(count).toBe(3)
      await cleanup()
    },
  }),
)
