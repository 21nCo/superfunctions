// Router whose generated document is invalid in a way the differ cannot read: a null security
// requirement on an operation.
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
          security: [null],
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
    ];
  },
};
