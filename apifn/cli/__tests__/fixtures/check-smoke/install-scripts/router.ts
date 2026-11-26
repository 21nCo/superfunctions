// The committed openapi.yml includes GET /install-script and GET /prepare-script, which this router serves only when
// the postinstall script (node_modules/.apifn-install-script-ran) and the prepare-dep prepare script
// (node_modules/.apifn-prepare-script-ran) ran: with allow_install_scripts: true the check passes. openapi.scripts-off.yml
// has neither route: with the default (npm ci --ignore-scripts) the check passes against it only if neither script ran.
import { existsSync } from "node:fs";

const installScriptRan = existsSync(new URL("./node_modules/.apifn-install-script-ran", import.meta.url));
const prepareScriptRan = existsSync(new URL("./node_modules/.apifn-prepare-script-ran", import.meta.url));

export default {
  getRoutes() {
    const routes = [
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
    if (installScriptRan) {
      routes.push({
        method: "GET",
        path: "/install-script",
        handler: async () => Response.json({ ran: true }),
        meta: {
          operationId: "getInstallScript",
          summary: "Served only after the postinstall script ran",
          tags: ["users"],
          responses: { 200: { description: "The install script ran" } },
        },
      });
    }
    if (prepareScriptRan) {
      routes.push({
        method: "GET",
        path: "/prepare-script",
        handler: async () => Response.json({ ran: true }),
        meta: {
          operationId: "getPrepareScript",
          summary: "Served only after the prepare-dep prepare script ran",
          tags: ["users"],
          responses: { 200: { description: "The prepare script ran" } },
        },
      });
    }
    return routes;
  },
};
