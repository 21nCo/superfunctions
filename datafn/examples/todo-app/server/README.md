# Todo App — Server

Backend for the DataFn Todo App example. Runs a Hono HTTP server with the
DataFn server runtime, backed by PostgreSQL via Drizzle ORM.

## Prerequisites

- **Node.js** ≥ 18
- **PostgreSQL** (local or hosted)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the database

Create a `.env` file in this directory:

```
DATABASE_URL=postgresql://user:password@localhost:5432/todo_app
```

### 3. Push schema to database

```bash
# Development — push Drizzle schema directly
npm run db:push

# Production — generate and apply migrations
npm run db:generate
npm run db:migrate
```

### 4. Start the server

```bash
# Development (hot-reload)
npm run dev

# Production
npm run build && npm run start
```

The server runs on `http://localhost:3000` by default (override with `PORT` env var).

## Endpoints

| Method | Path                | Description                          |
| ------ | ------------------- | ------------------------------------ |
| GET    | `/datafn/status`    | Server status, schema hash, limits   |
| POST   | `/datafn/query`     | Execute DFQL queries                 |
| POST   | `/datafn/mutation`  | Execute mutations (CRUD + relations) |
| POST   | `/datafn/transact`  | Atomic multi-step transactions       |
| POST   | `/datafn/clone`     | Full data download for initial sync  |
| POST   | `/datafn/pull`      | Incremental sync (cursor-based)      |
| POST   | `/datafn/push`      | Upload offline mutations             |
| POST   | `/datafn/seed`      | Seed data                            |

## Schema

The server defines two resources and one many-many relation:

- **todos** — id, text, completed, priority, createdAt, updatedAt
- **categories** — id, name, color, createdAt
- **todos ↔ categories** — many-many relation named `tags` / `todos`

## Available Scripts

| Script           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `npm run dev`    | Start dev server with hot-reload (tsx watch)   |
| `npm run build`  | Compile TypeScript                             |
| `npm run start`  | Run compiled server                            |
| `npm run db:generate` | Generate Drizzle migration files          |
| `npm run db:migrate`  | Apply migrations                          |
| `npm run db:push`     | Push schema directly (development)        |
| `npm run db:studio`   | Open Drizzle Studio (database browser)    |
