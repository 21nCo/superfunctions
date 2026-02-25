import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createFileFn } from "@filefn/server";
import { createLocalStorageAdapter } from "@superfunctions/storage-local";
import { createFakeDbAdapter } from "./adapters.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-filefn-client-version",
      "x-request-id",
    ],
  }),
);

const port = Number(process.env.PORT) || 3001;

const db = createFakeDbAdapter();
const storage = createLocalStorageAdapter({ rootDir: "./uploads" });

const fileFn = createFileFn({
  db,
  storage,
  policies: [
    {
      name: "public-image",
      contentTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
      maxSizeBytes: 10 * 1024 * 1024,
      visibility: "public",
    },
  ],
  auth: {
    required: false,
    resolveSession: async () => ({
      principalId: "demo-user",
      tenantId: "demo-org",
    }),
  },
  processing: {
    enabled: true,
  },
});

app.all("/filefn/*", async (c) => {
  const url = new URL(c.req.raw.url);
  const newPath = url.pathname.replace(/^\/filefn/, "") || "/";
  // access search params from original
  const newUrl = url.origin + newPath + url.search;

  // Create new request with identical init options
  const newReq = new Request(newUrl, {
    method: c.req.method,
    headers: c.req.header() as any, // Hono header keys are compatible
    body: c.req.raw.body,
    duplex: "half", // Required for Node streams in some versions, Hono/Fetch might need this
  } as any);

  const response = await fileFn.router.handle(newReq);
  if (!response) {
    return c.notFound();
  }
  return response;
});


console.log(`Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
