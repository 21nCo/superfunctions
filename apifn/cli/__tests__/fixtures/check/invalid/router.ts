// Router whose generated document is not valid OpenAPI.
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
          // Not an HTTP status code: the generated document fails OpenAPI validation.
          responses: { ok: { description: "All users" } },
        },
      },
    ];
  },
};
