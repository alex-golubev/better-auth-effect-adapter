import { describe, expect, it } from '@effect/vitest'
import type { BetterAuthOptions } from 'better-auth'
import { getAuthTables } from 'better-auth/db'
import { Effect } from 'effect'
import type { Dialect } from './dialect'
import { EffectSqlAdapterError } from './errors'
import { type IdStrategy, idStrategyOf, renderSchema, type SchemaConfig, schemaStatements } from './schema'

const dialects: ReadonlyArray<Dialect> = ['sqlite', 'pg', 'mysql']
const strategies: ReadonlyArray<IdStrategy> = ['string', 'serial', 'uuid']

const ddl = (options: BetterAuthOptions, config: SchemaConfig) => schemaStatements(getAuthTables(options), config)

describe('schemaStatements', () => {
  describe.each(dialects)('%s', (dialect) => {
    it.effect.each(strategies)('default schema with %s ids', (idStrategy) =>
      Effect.map(ddl({}, { dialect, idStrategy }), (statements) => {
        expect(renderSchema(statements)).toMatchSnapshot()
      }),
    )
  })

  it.effect('creates referenced tables before the tables that reference them', () =>
    Effect.gen(function* () {
      const statements = yield* ddl(
        {
          plugins: [
            {
              id: 'order-test',
              schema: {
                child: { fields: { parentId: { type: 'string', references: { model: 'parent', field: 'id' } } } },
                parent: { fields: { title: { type: 'string' } } },
              },
            },
          ],
        },
        { dialect: 'pg', idStrategy: 'string' },
      )
      const created = statements.flatMap((s) => /^CREATE TABLE "(\w+)"/.exec(s)?.[1] ?? [])
      expect(created.indexOf('user')).toBeLessThan(created.indexOf('session'))
      expect(created.indexOf('parent')).toBeLessThan(created.indexOf('child'))
    }),
  )

  it.effect('resolves custom model and field names, including in foreign keys', () =>
    Effect.gen(function* () {
      const sql = renderSchema(
        yield* ddl(
          {
            user: { modelName: 'user_custom', fields: { email: 'email_address' } },
            plugins: [
              {
                id: 'one-to-one-test',
                schema: {
                  oneToOneTable: {
                    modelName: 'one_to_one_table',
                    fields: {
                      oneToOne: {
                        type: 'string',
                        required: true,
                        unique: true,
                        fieldName: 'one_to_one',
                        references: { model: 'user', field: 'email' },
                      },
                    },
                  },
                },
              },
            ],
          },
          { dialect: 'mysql', idStrategy: 'serial' },
        ),
      )
      expect(sql).toContain('CREATE TABLE `user_custom`')
      expect(sql).toContain('`email_address` varchar(255) NOT NULL UNIQUE')
      expect(sql).toContain('FOREIGN KEY (`userId`) REFERENCES `user_custom` (`id`) ON DELETE CASCADE')
      // A non-id reference stays a string, even with serial ids.
      expect(sql).toContain('`one_to_one` varchar(255) NOT NULL UNIQUE')
      expect(sql).toContain('FOREIGN KEY (`one_to_one`) REFERENCES `user_custom` (`email_address`) ON DELETE CASCADE')
    }),
  )

  it.effect('applies rename to tables, columns, foreign keys and index names', () =>
    Effect.gen(function* () {
      const sql = renderSchema(
        yield* ddl(
          { session: { modelName: 'authSession' } },
          {
            dialect: 'pg',
            idStrategy: 'string',
            rename: (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          },
        ),
      )
      expect(sql).toContain('CREATE TABLE "auth_session"')
      expect(sql).toContain('"email_verified" boolean NOT NULL')
      expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE CASCADE')
      expect(sql).toContain('CREATE INDEX "auth_session_user_id_idx" ON "auth_session" ("user_id")')
      expect(sql).not.toMatch(/[a-z][A-Z]/)
    }),
  )

  it.effect('maps foreign keys to id with the id strategy', () =>
    Effect.gen(function* () {
      const fk = (dialect: Dialect, idStrategy: IdStrategy) =>
        Effect.map(ddl({}, { dialect, idStrategy }), (statements) =>
          statements
            .find((s) => s.includes('TABLE "session"') || s.includes('TABLE `session`'))
            ?.split('\n')
            .find((line) => line.includes('userId') && !line.includes('FOREIGN KEY'))
            ?.trim(),
        )
      expect(yield* fk('pg', 'string')).toBe('"userId" text NOT NULL,')
      expect(yield* fk('pg', 'serial')).toBe('"userId" integer NOT NULL,')
      expect(yield* fk('pg', 'uuid')).toBe('"userId" uuid NOT NULL,')
      expect(yield* fk('mysql', 'string')).toBe('`userId` varchar(255) NOT NULL,')
      expect(yield* fk('mysql', 'uuid')).toBe('`userId` varchar(36) NOT NULL,')
      expect(yield* fk('sqlite', 'serial')).toBe('"userId" integer NOT NULL,')
    }),
  )

  it.effect('creates table-level indexes and sizes MySQL varchar columns to fit the index key', () =>
    Effect.gen(function* () {
      const options: BetterAuthOptions = {
        plugins: [
          {
            id: 'indexes-test',
            schema: {
              item: {
                fields: {
                  tenant: { type: 'string' },
                  slug: { type: 'string' },
                  rank: { type: 'number' },
                },
                indexes: [
                  { fields: ['tenant', 'slug'], unique: true },
                  { fields: ['rank'], name: 'item_rank_custom' },
                ],
              },
            },
          },
        ],
      }
      const mysql = yield* ddl(options, { dialect: 'mysql', idStrategy: 'string' })
      expect(mysql).toContain('CREATE UNIQUE INDEX `item_tenant_slug_uidx` ON `item` (`tenant`, `slug`)')
      expect(mysql).toContain('CREATE INDEX `item_rank_custom` ON `item` (`rank`)')
      // 3072 bytes / 4 bytes per utf8mb4 char / 2 string columns, capped at 191.
      expect(renderSchema(mysql)).toContain('`tenant` varchar(191) NOT NULL')
      expect(renderSchema(yield* ddl(options, { dialect: 'pg', idStrategy: 'string' }))).toContain(
        '"tenant" text NOT NULL',
      )
    }),
  )

  it.effect('sizes MySQL string id foreign keys to fit the index key limit too', () =>
    Effect.gen(function* () {
      const options: BetterAuthOptions = {
        plugins: [
          {
            id: 'wide-index',
            schema: {
              grant: {
                fields: {
                  ownerId: { type: 'string', references: { model: 'user', field: 'id' } },
                  granteeId: { type: 'string', references: { model: 'user', field: 'id' } },
                  issuerId: { type: 'string', references: { model: 'user', field: 'id' } },
                  role: { type: 'string' },
                },
                indexes: [{ fields: ['ownerId', 'granteeId', 'issuerId', 'role'] }],
              },
            },
          },
        ],
      }
      const sql = renderSchema(yield* ddl(options, { dialect: 'mysql', idStrategy: 'string' }))
      // 4 columns × 191 chars × 4 bytes = 3056 bytes, within 3072.
      expect(sql).toContain('`ownerId` varchar(191) NOT NULL')
      expect(sql).toContain('`issuerId` varchar(191) NOT NULL')
      expect(sql).toContain('`role` varchar(191) NOT NULL')
      // Not indexed: the plain string id type.
      expect(renderSchema(yield* ddl({}, { dialect: 'mysql', idStrategy: 'string' }))).toContain(
        '`userId` varchar(255) NOT NULL',
      )
    }),
  )

  it.effect('creates field-level indexes for indexed, non-unique fields', () =>
    Effect.gen(function* () {
      const statements = yield* ddl({}, { dialect: 'sqlite', idStrategy: 'string' })
      expect(statements).toContain('CREATE INDEX "session_userId_idx" ON "session" ("userId")')
      expect(statements).toContain('CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier")')
      expect(statements.some((s) => s.includes('session_token'))).toBe(false)
    }),
  )

  it.effect('shortens long index names with a stable hash', () =>
    Effect.gen(function* () {
      const longField = 'a'.repeat(80)
      const statements = yield* ddl(
        { plugins: [{ id: 'long', schema: { item: { fields: { [longField]: { type: 'string', index: true } } } } }] },
        { dialect: 'pg', idStrategy: 'string' },
      )
      const name = statements
        .flatMap((s) => /^CREATE INDEX "(\w+)"/.exec(s)?.[1] ?? [])
        .find((n) => n.startsWith('item_'))
      expect(name).toMatch(/^item_a+_[0-9a-f]{8}_idx$/)
      expect(name?.length).toBeLessThanOrEqual(63)
    }),
  )

  it.effect('maps column types per dialect', () =>
    Effect.gen(function* () {
      const options: BetterAuthOptions = {
        plugins: [
          {
            id: 'types',
            schema: {
              item: {
                fields: {
                  flag: { type: 'boolean' },
                  count: { type: 'number' },
                  big: { type: 'number', bigint: true },
                  at: { type: 'date', required: false },
                  data: { type: 'json' },
                  tags: { type: 'string[]' },
                  nums: { type: 'number[]' },
                  kind: { type: ['a', 'b'], index: true },
                },
              },
            },
          },
        ],
      }
      const item = (dialect: Dialect) =>
        Effect.map(ddl(options, { dialect, idStrategy: 'string' }), (statements) =>
          statements.find((s) => /TABLE ["`]item["`]/.test(s)),
        )
      expect(yield* item('sqlite')).toMatchInlineSnapshot(`
      "CREATE TABLE "item" (
        "id" text NOT NULL PRIMARY KEY,
        "flag" integer NOT NULL,
        "count" integer NOT NULL,
        "big" bigint NOT NULL,
        "at" date,
        "data" text NOT NULL,
        "tags" text NOT NULL,
        "nums" text NOT NULL,
        "kind" text NOT NULL
      )"
    `)
      expect(yield* item('pg')).toMatchInlineSnapshot(`
      "CREATE TABLE "item" (
        "id" text NOT NULL PRIMARY KEY,
        "flag" boolean NOT NULL,
        "count" integer NOT NULL,
        "big" bigint NOT NULL,
        "at" timestamptz,
        "data" jsonb NOT NULL,
        "tags" jsonb NOT NULL,
        "nums" jsonb NOT NULL,
        "kind" text NOT NULL
      )"
    `)
      expect(yield* item('mysql')).toMatchInlineSnapshot(`
      "CREATE TABLE \`item\` (
        \`id\` varchar(255) NOT NULL PRIMARY KEY,
        \`flag\` boolean NOT NULL,
        \`count\` integer NOT NULL,
        \`big\` bigint NOT NULL,
        \`at\` datetime(3),
        \`data\` json NOT NULL,
        \`tags\` json NOT NULL,
        \`nums\` json NOT NULL,
        \`kind\` varchar(255) NOT NULL
      )"
    `)
    }),
  )

  it.effect('skips tables with disableMigrations', () =>
    Effect.gen(function* () {
      const statements = yield* ddl(
        {
          plugins: [
            { id: 'skip', schema: { external: { fields: { x: { type: 'string' } }, disableMigration: true } } },
          ],
        },
        { dialect: 'sqlite', idStrategy: 'string' },
      )
      expect(statements.some((s) => s.includes('"external"'))).toBe(false)
    }),
  )

  it.effect('escapes quotes in identifiers', () =>
    Effect.gen(function* () {
      const statements = yield* ddl(
        {
          plugins: [
            { id: 'quotes', schema: { item: { modelName: 'we"ird`name', fields: { x: { type: 'string' } } } } },
          ],
        },
        { dialect: 'pg', idStrategy: 'string' },
      )
      expect(statements.some((s) => s.startsWith('CREATE TABLE "we""ird`name"'))).toBe(true)
      const mysql = yield* ddl(
        {
          plugins: [
            { id: 'quotes', schema: { item: { modelName: 'we"ird`name', fields: { x: { type: 'string' } } } } },
          ],
        },
        { dialect: 'mysql', idStrategy: 'string' },
      )
      expect(mysql.some((s) => s.startsWith('CREATE TABLE `we"ird``name`'))).toBe(true)
    }),
  )

  // getAuthTables validates indexes, but createSchema may get tables from elsewhere.
  it.effect('fails with EffectSqlAdapterError on indexes over unknown or non-indexable fields', () =>
    Effect.gen(function* () {
      const errorFor = (fields: [string, ...Array<string>]) =>
        Effect.flip(
          schemaStatements(
            { item: { modelName: 'item', fields: { data: { type: 'json' } }, indexes: [{ fields }] } },
            { dialect: 'pg', idStrategy: 'string' },
          ),
        )
      expect(yield* errorFor(['missing'])).toBeInstanceOf(EffectSqlAdapterError)
      expect((yield* errorFor(['missing'])).message).toMatch(/unknown field "missing"/)
      expect((yield* errorFor(['data'])).message).toMatch(/not indexable/)
    }),
  )

  it.effect('fails on invalid custom index names', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        schemaStatements(
          {
            item: { modelName: 'item', fields: { x: { type: 'string' } }, indexes: [{ fields: ['x'], name: '1bad' }] },
          },
          { dialect: 'pg', idStrategy: 'string' },
        ),
      )
      expect(error.message).toMatch(/must start with a letter/)
    }),
  )
})

describe('idStrategyOf', () => {
  it('reads advanced.database.generateId', () => {
    expect(idStrategyOf({})).toBe('string')
    expect(idStrategyOf({ advanced: { database: { generateId: 'serial' } } })).toBe('serial')
    expect(idStrategyOf({ advanced: { database: { generateId: 'uuid' } } })).toBe('uuid')
    expect(idStrategyOf({ advanced: { database: { generateId: () => 'x' } } })).toBe('string')
  })
})
