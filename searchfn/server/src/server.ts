import { createRouter, type Router, type Route } from "@superfunctions/http";
import type { Adapter } from "@superfunctions/db";
import type { DatafnSchema } from "@datafn/core";
import { indexData } from "./indexing.js";
import { searchIndex } from "./search.js";

export interface SearchFnConfig<TContext = any> {
  schema: DatafnSchema;
  db: Adapter;
  /**
   * Optional prefix for internal tables used by searchfn
   * Default: "_searchfn_"
   */
  tablePrefix?: string;
}

export interface SearchFnServer<TContext = any> {
  router: Router<TContext>;
}

export async function createSearchFnServer<TContext = any>(
  config: SearchFnConfig<TContext>
): Promise<SearchFnServer<TContext>> {
  const { schema, db } = config;

  // Handler for triggering indexing
  // POST /searchfn/index
  const indexHandler = async (req: Request) => {
    try {
      // In a real implementation, this might be triggered via webhooks or run in background
      // Here we allow manual trigger for specific model or all
      const body = await req.json().catch(() => ({}));
      const model = body.model; // Optional: index specific model

      const result = await indexData({
        schema,
        db,
        model,
        tablePrefix: config.tablePrefix
      });

      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error: any) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  };

  // Handler for search
  // POST /searchfn/search
  const searchHandler = async (req: Request) => {
    try {
      const body = await req.json();
      const { query, model, limit } = body;

      if (!query) {
        return new Response(JSON.stringify({ ok: false, error: "Missing query" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      const results = await searchIndex({
        schema,
        db,
        query,
        model,
        limit,
        tablePrefix: config.tablePrefix
      });

      return new Response(JSON.stringify({ ok: true, results }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error: any) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  };

  const routes: Route<TContext>[] = [
    {
      method: "POST",
      path: "/searchfn/index",
      handler: indexHandler,
    },
    {
      method: "POST",
      path: "/searchfn/search",
      handler: searchHandler,
    }
  ];

  const router = createRouter<TContext>({
    routes,
    basePath: "/",
  });

  return { router };
}
