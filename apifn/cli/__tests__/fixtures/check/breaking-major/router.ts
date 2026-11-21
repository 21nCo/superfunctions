// Breaking change covered by a major bump.
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
    ];
  },
};
