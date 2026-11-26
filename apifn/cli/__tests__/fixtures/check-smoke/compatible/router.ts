// Compatible contract: its committed openapi.yml matches this router and is the base of the breaking fixture.
// It prints while loading, as caller routers may: the API check workflow's JSON report must not include this line.
console.log("check-smoke: compatible router loaded");

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
    ];
  },
};
