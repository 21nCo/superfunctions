/**
 * BrowseFn HTTP Router using @superfunctions/http
 */

import { createRouter, type Router } from "@superfunctions/http";
import type { BrowseFn } from "../core/browse-fn.js";

interface BrowseFnContext {
  browseFn: BrowseFn;
}

/**
 * Create an HTTP router for BrowseFn endpoints
 *
 * @param browseFn - BrowseFn instance
 * @returns Router instance
 */
export function createBrowseFnRouter(
  browseFn: BrowseFn
): Router<BrowseFnContext> {
  return createRouter<BrowseFnContext>({
    context: { browseFn },
    routes: [
      // Web: Get Page
      {
        method: "POST",
        path: "/web/page",
        handler: async (req, ctx) => {
          try {
            const body = await ctx.json();
            const { url, options } = body;

            if (!url) {
              return Response.json({ error: "Missing url" }, { status: 400 });
            }

            const page = await ctx.browseFn.web.getPage(url, options);

            // Handle screenshot buffer if present (convert to base64 for JSON)
            if (page.screenshot && Buffer.isBuffer(page.screenshot)) {
              (page as any).screenshot = page.screenshot.toString("base64");
            }

            return Response.json({ success: true, page });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },

      // Web: Get Multiple Metadata
      {
        method: "POST",
        path: "/web/metadata",
        handler: async (req, ctx) => {
          try {
            const body = await ctx.json();
            const { urls, options } = body;

            if (!urls || !Array.isArray(urls)) {
              return Response.json(
                { error: "Missing or invalid urls array" },
                { status: 400 }
              );
            }

            const results = await ctx.browseFn.web.getMultipleMetadata(
              urls,
              options
            );
            return Response.json({ success: true, results });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },

      // Images: Search
      {
        method: "GET",
        path: "/images/search",
        handler: async (req, ctx) => {
          try {
            const query = ctx.query.get("q");
            if (!query) {
              return Response.json(
                { error: "Missing q (query) parameter" },
                { status: 400 }
              );
            }

            const options: any = {
              provider: ctx.query.get("provider") || undefined,
              page: ctx.query.get("page")
                ? Number(ctx.query.get("page"))
                : undefined,
              perPage: ctx.query.get("perPage")
                ? Number(ctx.query.get("perPage"))
                : undefined,
              orientation: ctx.query.get("orientation") as any,
              color: ctx.query.get("color") || undefined,
              orderBy: ctx.query.get("orderBy") as any,
            };

            const result = await ctx.browseFn.images.search(query, options);
            return Response.json({ success: true, result });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },

      // Images: Download
      {
        method: "POST",
        path: "/images/download",
        handler: async (req, ctx) => {
          try {
            const body = await ctx.json();
            const { url, options } = body;

            if (!url) {
              return Response.json({ error: "Missing url" }, { status: 400 });
            }

            const result = await ctx.browseFn.images.download(url, options);
            return Response.json({ success: true, result });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },

      // Geo: Reverse Geocode
      {
        method: "GET",
        path: "/geo/reverse",
        handler: async (req, ctx) => {
          try {
            const lat = Number(ctx.query.get("lat"));
            const lng = Number(ctx.query.get("lng"));
            const provider = ctx.query.get("provider") || undefined;

            if (isNaN(lat) || isNaN(lng)) {
              return Response.json(
                { error: "Invalid lat/lng parameters" },
                { status: 400 }
              );
            }

            const result = await ctx.browseFn.geo.reverseGeocode(
              { lat, lng },
              { provider }
            );
            return Response.json({ success: true, result });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },

      // Geo: Geocode
      {
        method: "GET",
        path: "/geo/geocode",
        handler: async (req, ctx) => {
          try {
            const address = ctx.query.get("address");
            if (!address) {
              return Response.json(
                { error: "Missing address parameter" },
                { status: 400 }
              );
            }

            const provider = ctx.query.get("provider") || undefined;
            const limit = ctx.query.get("limit")
              ? Number(ctx.query.get("limit"))
              : undefined;

            const results = await ctx.browseFn.geo.geocode(address, {
              provider,
              limit,
            });
            return Response.json({ success: true, results });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },

      // Geo: Search
      {
        method: "GET",
        path: "/geo/search",
        handler: async (req, ctx) => {
          try {
            const query = ctx.query.get("q");
            if (!query) {
              return Response.json(
                { error: "Missing q (query) parameter" },
                { status: 400 }
              );
            }

            const lat = ctx.query.get("lat")
              ? Number(ctx.query.get("lat"))
              : undefined;
            const lng = ctx.query.get("lng")
              ? Number(ctx.query.get("lng"))
              : undefined;
            const radius = ctx.query.get("radius")
              ? Number(ctx.query.get("radius"))
              : undefined;
            const provider = ctx.query.get("provider") || undefined;
            const limit = ctx.query.get("limit")
              ? Number(ctx.query.get("limit"))
              : undefined;

            const options: any = {
              query,
              provider,
              radius,
              limit,
            };

            if (lat !== undefined && lng !== undefined) {
              options.center = { lat, lng };
            }

            const results = await ctx.browseFn.geo.search(options);
            return Response.json({ success: true, results });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },

      // Geo: Place Details
      {
        method: "GET",
        path: "/geo/places/:id",
        handler: async (req, ctx) => {
          try {
            const { id } = ctx.params;
            const provider = ctx.query.get("provider") || undefined;
            const fieldsParam = ctx.query.get("fields");
            const fields = fieldsParam ? fieldsParam.split(",") : undefined;

            const result = await ctx.browseFn.geo.getPlaceDetails(id, {
              provider,
              fields,
            });
            return Response.json({ success: true, result });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },

      // Metrics
      {
        method: "GET",
        path: "/metrics",
        handler: async (req, ctx) => {
          try {
            const timeRange = ctx.query.get("timeRange") as any;
            const groupBy = ctx.query.get("groupBy") as any;

            const metrics = await ctx.browseFn.getMetrics({
              timeRange,
              groupBy,
            });
            return Response.json({ success: true, metrics });
          } catch (error) {
            return Response.json(
              { error: (error as Error).message },
              { status: 500 }
            );
          }
        },
      },
    ],
  });
}
