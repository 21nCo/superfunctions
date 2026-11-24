// Compatible change: adds GET /health, keeps the version.
export default {
  getRoutes() {
    return [
      {
        method: "GET",
        path: "/users/:id",
        handler: async () => Response.json({ id: "1" }),
        meta: {
          operationId: "getUser",
          summary: "Get a user",
          tags: ["users"],
          responses: { 200: { description: "The user" } },
        },
      },
      {
        method: "GET",
        path: "/users",
        handler: async () => Response.json([]),
        meta: {
          operationId: "listUsers",
          summary: "List users",
          tags: ["users"],
          responses: { 200: { description: "All users" } },
        },
      },
      {
        method: "GET",
        path: "/health",
        handler: async () => Response.json({ ok: true }),
        meta: {
          operationId: "health",
          summary: "Health check",
          tags: ["ops"],
          responses: { 200: { description: "Healthy" } },
        },
      },
    ];
  },
};
