import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzleAdapter } from "@superfunctions/db/adapters";
import { schema } from "./schema.js";
import { config } from "dotenv";

// Load environment variables from .env file
config();

const { Pool } = pg;

// Database connection URL
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/todo_app";

console.log("Database URL:", DATABASE_URL ? `${DATABASE_URL.split('@')[0]}@***` : "not set");

// Initialize Postgres Pool
export const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Initialize Drizzle
// IMPORTANT: We must pass the schema to drizzle() for the adapter to work!
export const db = drizzle(pool, { schema });

// Initialize DataFn Adapter
export const adapter = drizzleAdapter({
  db,
  dialect: "postgres",
  debug: true,
});
