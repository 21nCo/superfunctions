import { createRouter } from "@superfunctions/http";
import { WatchFn } from "../core/watch-fn";
import { HttpHandlers } from "./handlers";

export function createWatchFnRouter(watch: WatchFn) {
  const handlers = new HttpHandlers(watch);

  return createRouter({
    routes: [
      {
        path: "/health",
        method: "GET",
        handler: () => handlers.health(),
      },
      {
        path: "/ingest",
        method: "POST",
        handler: (req) => handlers.ingest(req),
      },
      { path: "/issues/status", method: "POST", handler: (req) => handlers.issueStatus(req) },
      {
        path: "/query",
        method: "POST",
        handler: (req) => handlers.query(req),
      },
    ],
  });
}
