/**
 * Test DB helpers. Reuses the singleton `db` Prisma client from `src/db.ts`
 * — it picks up DATABASE_URL from the test env stubbed in `vitest.setup.ts`.
 */

import { db } from "../../src/db.js";

export { db };

/**
 * Truncate every public table except `_prisma_migrations`, resetting
 * identity sequences and cascading through FKs. Cheap enough to run
 * after every test on an empty schema; the connection stays open.
 */
export async function truncateAll(): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export async function disconnectDb(): Promise<void> {
  await db.$disconnect();
}
