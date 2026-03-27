import { describe, expect, it } from 'vitest';
import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { drizzleAdapter } from './index.js';

const users = mysqlTable('users', {
  id: varchar('id', { length: 255 }).primaryKey(),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }),
});

describe('DrizzleAdapter - MySQL upsert follow-ups', () => {
  it('throws when MySQL upsert cannot reselect the inserted row', async () => {
    const mockDb = {
      _: {
        fullSchema: {
          users,
        },
      },
      insert() {
        return {
          values() {
            return {
              async execute() {
                return { rowsAffected: 1 };
              },
              onDuplicateKeyUpdate() {
                return {
                  async execute() {
                    return { rowsAffected: 1 };
                  },
                };
              },
            };
          },
        };
      },
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return {
                      async execute() {
                        return [];
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const adapter = drizzleAdapter({
      db: mockDb,
      dialect: 'mysql',
      debug: false,
    });

    await expect(
      adapter.upsert({
        model: 'users',
        where: [{ field: 'id', operator: 'eq', value: 'u1' }],
        create: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
        update: {},
      }),
    ).rejects.toThrow('Upsert failed to return a row');
  });
});
