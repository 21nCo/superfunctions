import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { DatafnSchema } from "@datafn/core";

// ═══════════════════════════════════════════════════════════════════════════
// Drizzle Schema (database tables)
// ═══════════════════════════════════════════════════════════════════════════

export const todos = pgTable("todos", {
  id: uuid("id").primaryKey().defaultRandom(),
  text: text("text").notNull(),
  completed: boolean("completed").notNull().default(false),
  priority: integer("priority").default(3),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
});

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#646cff"),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
});

/** Join table for the todos <-> categories many-many relation. */
export const todoCategories = pgTable("todo_categories", {
  todoId: uuid("todo_id")
    .notNull()
    .references(() => todos.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "cascade" }),
});

// Export all tables for Drizzle config / adapter
export const schema = { todos, categories, todoCategories };

// ═══════════════════════════════════════════════════════════════════════════
// DataFn Schema (shared with client)
// ═══════════════════════════════════════════════════════════════════════════

export const datafnSchema: DatafnSchema = {
  resources: [
    {
      name: "todos",
      version: 1,
      idPrefix: "todo",
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        { name: "text", type: "string", required: true, minLength: 1, maxLength: 500 },
        { name: "completed", type: "boolean", required: true, default: false },
        { name: "priority", type: "number", required: false, min: 1, max: 5, default: 3 },
        { name: "createdAt", type: "date", required: true },
        { name: "updatedAt", type: "date", required: true },
      ],
      indices: {
        base: ["completed", "created_at"],
      },
    },
    {
      name: "categories",
      version: 1,
      idPrefix: "cat",
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        { name: "name", type: "string", required: true, minLength: 1, maxLength: 100 },
        { name: "color", type: "string", required: true, default: "#646cff" },
        { name: "createdAt", type: "date", required: true },
      ],
      indices: {
        base: ["name"],
      },
    },
  ],
  relations: [
    {
      from: "todos",
      to: "categories",
      type: "many-many",
      relation: "tags",
      inverse: "todos",
    },
  ],
};
