# @catchfn/server

Server-side implementation for [CatchFn](../../typescript), enabling self-hosted bug reporting.

## Features

- 🪲 **Bug Storage** - Store and retrieve bug reports with full context
- 🔌 **Framework Agnostic** - Works with Express, Hono, Fastify, Next.js, etc.
- 📂 **File Attachments** - Designed to work with `@filefn/server` for screenshots/recordings

## Installation

```bash
npm install @catchfn/server @superfunctions/http @superfunctions/db
```

## Usage

### Basic Setup

```typescript
import { createCatchFnServer } from '@catchfn/server';
import { createRouter } from '@superfunctions/http';
import { toExpress } from '@superfunctions/http-express'; // or other adapter
import express from 'express';

// 1. Initialize DB Adapter (e.g. Postgres, SQLite)
const db = ...; 

// 2. Initialize CatchFn Server
const { router } = createCatchFnServer({
  db,
  tableName: 'bugs' // optional
});

// 3. Mount in your app
const app = express();
app.use(express.json());
app.use('/api/catchfn', toExpress(router));

app.listen(3000);
```

### With File Uploads (Screenshots/Recordings)

To support file uploads (like screenshots from the browser), mount `@filefn/server` alongside CatchFn.

```typescript
import { createFileFn } from '@filefn/server';
import { createCatchFnServer } from '@catchfn/server';

// ... initialize storage adapter ...

const fileFn = createFileFn({
  db,
  storage,
  namespace: 'catchfn-uploads'
});

const catchFn = createCatchFnServer({ db });

app.use('/api/files', toExpress(fileFn.router));
app.use('/api/bugs', toExpress(catchFn.router));
```

## API Endpoints

- `POST /bugs` - Create a new bug report
- `GET /bugs` - List bugs
- `GET /bugs/:id` - Get bug details

## Client Configuration

Configure your client to point to this server:

```typescript
// Client-side code (Browser Extension / App)
// Note: You'll need to implement the transport to send to this API
// catchfn client currently logs to console, but can be hooked via beforeSend or custom transport
```
