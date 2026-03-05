# Исследование: миграция e2e тестов с better-auth 1.4 → 1.5

## Проблема

После обновления `better-auth` с `1.4.18` → `1.5.3` экспорт `better-auth/adapters/test` (содержавший `runAdapterTest`) полностью удалён. E2e тесты не компилируются.

## Что было в старом `runAdapterTest`

27 тест-кейсов, тестирующих адаптер напрямую (без betterAuth инстанса):
- CRUD: create, findOne, findMany, update, updateMany, delete, deleteMany
- Операторы: in, not_in, contains, starts_with, ends_with, connectors (AND/OR)
- Пагинация: sortBy, limit, offset
- select (выбор конкретных полей)
- Модифицированные имена полей (user.fields.email = "email_address")
- Ссылочные поля (session.userId)
- Транзакции: rollback, return result
- generateId (кастомный генератор ID)
- Граничные случаи: delete/find несуществующей записи

Исходник старой версии сохранён в pnpm кэше:
`node_modules/.pnpm/better-auth@1.4.18_.../node_modules/better-auth/dist/adapters/test.mjs`

## Что пришло на замену

### `@better-auth/test-utils` (npm пакет, v1.5.3)

- **Описание**: "Testing utilities for Better Auth adapter development"
- **Экспорт**: `@better-auth/test-utils/adapter`
- **Peer deps**: `@better-auth/core`, `better-auth`, `vitest`

Экспортирует:
- `testAdapter` — фреймворк: setup/teardown/migrations/stats reporting
- `createTestSuite` — утилита для описания тест-кейсов с хелперами:
  - `adapter` — доступ к адаптеру
  - `generate()` / `insertRandom()` — генерация тестовых данных (user, session, verification, account)
  - `cleanup()` / `hardCleanup()` — очистка данных
  - `modifyBetterAuthOptions()` / `getBetterAuthOptions()`
  - `getAuth()` — инстанс betterAuth
  - `sortModels()`, `tryCatch()`, `transformGeneratedModel()`
- Типы: `InsertRandomFn`, `TestEntry`, `TestSuiteStats`, `Logger`

**Важно**: это **фреймворк** для написания тестов, а не готовый набор тест-кейсов. Тест-кейсы нужно писать самим.

### `testUtils` plugin (из `better-auth/plugins`)

Это **другое** — плагин для тестирования auth-потоков (логин, сессии, OTP), не для тестирования адаптера. Предоставляет:
- `test.createUser()`, `test.saveUser()`, `test.deleteUser()`
- `test.login()`, `test.getAuthHeaders()`, `test.getCookies()`
- `test.getOTP()` (с опцией `captureOTP: true`)

### `getTestInstance` (из `better-auth/test`)

Создаёт полный инстанс betterAuth с Kysely для тестирования. Жёстко привязан к Kysely (сам создаёт БД, миграции, cleanup через Kysely). Не подходит для тестирования кастомных адаптеров.

## Как тестируются адаптеры в монорепе better-auth

Адаптеры вынесены в отдельные пакеты (`packages/drizzle-adapter`, `packages/kysely-adapter`, etc.). На данный момент у них только юнит-тесты с моками (проверка создания инстанса, проверка схемы). Полноценных e2e/интеграционных тестов через `@better-auth/test-utils` пока нет — видимо, миграция ещё в процессе.

## Варианты для нас

1. **Использовать `@better-auth/test-utils`** (`testAdapter` + `createTestSuite`) — писать свои тест-кейсы через их хелперы. Плюс: официальный фреймворк, если better-auth добавит стандартные тест-сьюты — сможем подключить.

2. **Свои vitest тесты напрямую** — создать betterAuth инстанс с нашим адаптером, тестировать через `auth.api` (signUp, getSession и т.д.) — реальный e2e через весь стек.

3. **Свои CRUD тесты** — тестировать адаптер напрямую (create/findOne/update/delete) без betterAuth, аналогично старому `runAdapterTest`, но написанному нами.

## Структура репозитория better-auth (для справки)

Монорепо, 20 пакетов. Ключевые:
- `packages/better-auth` — основной пакет
- `packages/core` — ядро (`@better-auth/core`)
- `packages/test-utils` — тестовые утилиты (`@better-auth/test-utils`)
- `packages/drizzle-adapter`, `packages/kysely-adapter`, `packages/prisma-adapter`, etc. — адаптеры
