import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const serverConfigTable = pgTable("server_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
