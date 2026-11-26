// The committed openapi.yml includes GET /install-script, which this router serves only when the postinstall script
// ran (node_modules/.apifn-install-script-ran): with allow_install_scripts: true the check passes, and with the
// default (npm ci --ignore-scripts) it reports drift.
import { existsSync } from "node:fs";

const installScriptRan = existsSync(new URL("./node_modules/.apifn-install-script-ran", import.meta.url));

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
    return routes;
  },
};
