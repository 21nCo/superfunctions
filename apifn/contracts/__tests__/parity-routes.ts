// Both exporters read routes through `router.getRoutes()` only, so a plain
// route list stands in for a @superfunctions/http router.
// One router carries both metadata shapes: the SchemaDescriptor fields read by
// @apifn/core's introspection and `meta.openapi` read by @superfunctions/http-openapi.
const project = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "string" }, name: { type: "string" } },
};
const problem = {
  type: "object",
  required: ["title", "status"],
  properties: { title: { type: "string" }, status: { type: "integer" } },
};
const projectPage = { type: "object", required: ["items"], properties: { items: { type: "array", items: project } } };
const projectInput = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
const handler = () => Response.json({ ok: true });

export const PARITY_TITLE = "Projects API";
export const PARITY_VERSION = "2026-10-01";

export function createParityRouter() {
  const routes = [
      {
        method: "POST",
        path: "/workspaces/:workspaceId/projects",
        handler,
        meta: {
          operationId: "createProject",
          summary: "Create a project",
          tags: ["projects"],
          body: projectInput,
          responses: {
            201: { description: "Created", schema: project },
            409: { description: "Conflict", schema: problem },
          },
          openapi: {
            operationId: "createProject",
            summary: "Create a project",
            tags: ["projects"],
            requestBodySchema: projectInput,
            responseSchemas: { "201": project, "409": problem },
          },
        },
      },
      {
        method: "GET",
        path: "/workspaces/:workspaceId/projects",
        handler,
        meta: {
          operationId: "listProjects",
          summary: "List projects",
          tags: ["projects"],
          query: { limit: { type: "integer" } },
          responses: { 200: { description: "A page of projects", schema: projectPage } },
          openapi: {
            operationId: "listProjects",
            summary: "List projects",
            tags: ["projects"],
            responseSchemas: { "200": projectPage },
          },
        },
      },
      {
        method: "DELETE",
        path: "/workspaces/:workspaceId/projects/:projectId",
        handler,
        meta: {
          operationId: "removeProject",
          deprecated: true,
          responses: { 204: { description: "Deleted" } },
          openapi: { operationId: "removeProject" },
        },
      },
      {
        method: "GET",
        path: "/workspaces/:workspaceId/projects/:projectId",
        handler,
        meta: {
          operationId: "getProject",
          summary: "Get a project",
          responses: {
            200: { description: "The project", schema: project },
            404: { description: "Not found", schema: problem },
          },
          openapi: {
            operationId: "getProject",
            summary: "Get a project",
            responseSchemas: { "200": project, "404": problem },
          },
        },
      },
  ];
  return { getRoutes: () => routes };
}
