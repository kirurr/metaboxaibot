import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
	//@ts-expect-error	earylyAccess is not typed yet
  earlyAccess: true,
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://metabox:metabox_password@localhost:5432/metabox_db",
  },
  migrate: {
    async adapter() {
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const { default: pg } = await import("pg");

      const connectionString = process.env.DATABASE_URL!;
      const pool = new pg.Pool({ connectionString });
      return new PrismaPg(pool);
    },
  },
});
