/**
 * TV-WATCH-004: apifnWatchMiddleware composes with the shared @superfunctions/http router.
 *
 * This file sits under `src/` so `tsc --noEmit` (the package's type check) compiles the
 * documented typed registrations below against the real router `Middleware` contract.
 * The watchfn event API is replaced by a fake sink installed as the global `fetch`.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createRouter, type Middleware, type Route, type RouteContext } from "@superfunctions/http";
import { apifnWatchMiddleware } from "../watchfn.js";

const BASE_URL = "http://watchfn.local:7100";

interface RecordedEvent {
    method: string;
    path: string;
    status_code: number;
    duration_ms: number;
    timestamp: string;
}

interface FakeSink {
    events: RecordedEvent[];
    calls: Array<{ url: string; init: RequestInit }>;
}

/** Installs a fake watchfn event API as the global fetch and returns what it receives. */
function installFakeSink(reply: () => Promise<Response> = async () => new Response(null, { status: 202 })): FakeSink {
    const sink: FakeSink = { events: [], calls: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        sink.calls.push({ url, init });
        sink.events.push(JSON.parse(String(init.body)) as RecordedEvent);
        return reply();
    }));
    return sink;
}

function routeContext(request: Request): RouteContext {
    const url = new URL(request.url);
    return {
        params: {},
        query: url.searchParams,
        url,
        json: <T = unknown>() => request.json() as Promise<T>,
        formData: () => request.formData(),
        text: () => request.text(),
    };
}

/** A handler response the middleware must forward untouched. */
function teapot(): Response {
    return new Response("short and stout", {
        status: 418,
        headers: { "x-handler": "teapot", "content-type": "text/plain" },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("TV-WATCH-004: apifnWatchMiddleware typed registration", () => {
    interface AppContext {
        tenantId: string;
    }

    it("compiles as router-level, route-level and dynamic middleware for a typed router", async () => {
        const sink = installFakeSink();
        const route: Route<AppContext> = {
            method: "GET",
            path: "/tenants/:id",
            middleware: [apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false })],
            handler: (_request, context) => Response.json({ tenantId: context.tenantId, id: context.params.id }),
        };
        const router = createRouter<AppContext>({
            routes: [route],
            context: { tenantId: "tenant-a" },
            middleware: [apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false })],
        });
        // The registration documented in the README.
        router.use(apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false }));

        expectTypeOf(apifnWatchMiddleware({ baseUrl: BASE_URL })).toMatchTypeOf<Middleware<AppContext>>();
        expectTypeOf(apifnWatchMiddleware<AppContext>({ baseUrl: BASE_URL })).toEqualTypeOf<Middleware<AppContext>>();

        const response = await router.handle(new Request("http://api.local/tenants/t-1"));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ tenantId: "tenant-a", id: "t-1" });
        expect(sink.events.map((event) => event.status_code)).toEqual([200, 200, 200]);
    });
});

describe("TV-WATCH-004: apifnWatchMiddleware through the shared router", () => {
    it("returns the handler's non-200 status, headers and body and records that status", async () => {
        const sink = installFakeSink();
        const router = createRouter({
            routes: [{ method: "POST", path: "/brew", handler: () => teapot() }],
        });
        router.use(apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false }));

        const response = await router.handle(new Request("http://api.local/brew?kind=green", { method: "POST" }));

        expect(response.status).toBe(418);
        expect(response.headers.get("x-handler")).toBe("teapot");
        expect(response.bodyUsed).toBe(false);
        expect(await response.text()).toBe("short and stout");

        expect(sink.calls).toHaveLength(1);
        expect(sink.calls[0].url).toBe(`${BASE_URL}/api/events`);
        expect(sink.calls[0].init.method).toBe("POST");
        expect(sink.events[0]).toMatchObject({ method: "POST", path: "/brew", status_code: 418 });
        expect(typeof sink.events[0].duration_ms).toBe("number");
        expect(Number.isNaN(Date.parse(sink.events[0].timestamp))).toBe(false);
    });

    it("records the status of the router's error response when the handler throws", async () => {
        const sink = installFakeSink();
        const router = createRouter({
            routes: [{ method: "GET", path: "/boom", handler: () => { throw new Error("handler failed"); } }],
            onError: () => Response.json({ error: "unavailable" }, { status: 503 }),
        });
        router.use(apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false }));

        const response = await router.handle(new Request("http://api.local/boom"));

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "unavailable" });
        expect(sink.events[0]).toMatchObject({ method: "GET", path: "/boom", status_code: 503 });
    });

    it("does not hold the response for the event POST by default (fire-and-forget)", async () => {
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const sink = installFakeSink(async () => {
            await postGate;
            return new Response(null, { status: 202 });
        });
        const router = createRouter({ routes: [{ method: "GET", path: "/brew", handler: () => teapot() }] });
        router.use(apifnWatchMiddleware({ baseUrl: BASE_URL }));

        const response = await router.handle(new Request("http://api.local/brew"));

        expect(response.status).toBe(418);
        expect(await response.text()).toBe("short and stout");
        expect(sink.events[0]).toMatchObject({ status_code: 418 });
        releasePost();
    });

    it("sends the Authorization header when apiKey is provided", async () => {
        const sink = installFakeSink();
        const router = createRouter({ routes: [{ method: "GET", path: "/", handler: () => new Response("ok") }] });
        router.use(apifnWatchMiddleware({ baseUrl: `${BASE_URL}/`, apiKey: "test-watch-api-key", fireAndForget: false }));

        await router.handle(new Request("http://api.local/"));

        expect(sink.calls[0].url).toBe(`${BASE_URL}/api/events`);
        expect((sink.calls[0].init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-watch-api-key");
    });
});

describe("TV-WATCH-004: apifnWatchMiddleware response identity and failure policy", () => {
    it("returns the same downstream Response object without reading its body", async () => {
        installFakeSink();
        const downstream = teapot();
        const request = new Request("http://api.local/brew");
        const middleware = apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false });

        const response = await middleware(request, routeContext(request), async () => downstream);

        expect(response).toBe(downstream);
        expect(downstream.bodyUsed).toBe(false);
    });

    it.each([
        { mode: "awaited", fireAndForget: false },
        { mode: "fire-and-forget", fireAndForget: true },
    ])("preserves the handler response and warns when the event POST fails ($mode)", async ({ fireAndForget }) => {
        const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
        vi.stubGlobal("fetch", fetchMock);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const router = createRouter({ routes: [{ method: "GET", path: "/brew", handler: () => teapot() }] });
        router.use(apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget }));

        const response = await router.handle(new Request("http://api.local/brew"));

        expect(response.status).toBe(418);
        expect(response.headers.get("x-handler")).toBe("teapot");
        expect(await response.text()).toBe("short and stout");
        await vi.waitFor(() => {
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to send event to watchfn: ECONNREFUSED"));
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("warns when the watchfn event API rejects the event and still returns the handler response", async () => {
        installFakeSink(async () => new Response("unavailable", { status: 503 }));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const router = createRouter({ routes: [{ method: "GET", path: "/brew", handler: () => teapot() }] });
        router.use(apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false }));

        const response = await router.handle(new Request("http://api.local/brew"));

        expect(response.status).toBe(418);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Event POST returned HTTP 503"));
    });

    it("silent mode suppresses telemetry warnings without changing the response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const router = createRouter({ routes: [{ method: "GET", path: "/brew", handler: () => teapot() }] });
        router.use(apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false, silent: true }));

        const response = await router.handle(new Request("http://api.local/brew"));

        expect(response.status).toBe(418);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    describe("telemetry and warning failures stay inside the telemetry boundary", () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

        beforeEach(() => {
            unhandled.length = 0;
            process.on("unhandledRejection", onUnhandled);
        });

        afterEach(() => {
            process.off("unhandledRejection", onUnhandled);
        });

        /** Lets Node process any rejection left unhandled by the detached POST. */
        const settleRejections = () => new Promise((resolve) => setTimeout(resolve, 20));

        it.each([
            { mode: "awaited", fireAndForget: false },
            { mode: "fire-and-forget", fireAndForget: true },
        ])("a prototype-less fetch rejection is reported safely and the handler response is kept ($mode)", async ({ fireAndForget }) => {
            const fetchMock = vi.fn().mockRejectedValue(Object.create(null));
            vi.stubGlobal("fetch", fetchMock);
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            const router = createRouter({ routes: [{ method: "GET", path: "/brew", handler: () => teapot() }] });
            router.use(apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget }));

            const response = await router.handle(new Request("http://api.local/brew"));

            expect(response.status).toBe(418);
            expect(response.headers.get("x-handler")).toBe("teapot");
            expect(await response.text()).toBe("short and stout");
            await vi.waitFor(() => {
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to send event to watchfn: unknown error"));
            });
            await settleRejections();
            expect(unhandled).toEqual([]);
        });

        it.each([
            { mode: "awaited", fireAndForget: false },
            { mode: "fire-and-forget", fireAndForget: true },
        ])("a throwing console.warn does not replace the handler response ($mode)", async ({ fireAndForget }) => {
            const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
            vi.stubGlobal("fetch", fetchMock);
            vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("warning sink unavailable"); });
            const router = createRouter({ routes: [{ method: "GET", path: "/brew", handler: () => teapot() }] });
            router.use(apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget }));

            const response = await router.handle(new Request("http://api.local/brew"));

            expect(response.status).toBe(418);
            expect(response.headers.get("x-handler")).toBe("teapot");
            expect(await response.text()).toBe("short and stout");
            await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
            await settleRejections();
            expect(unhandled).toEqual([]);
        });

        it("rethrows only the original downstream error when telemetry and warnings also fail", async () => {
            vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.create(null)));
            vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("warning sink unavailable"); });
            const failure = new Error("downstream failed");
            const request = new Request("http://api.local/boom");
            const middleware = apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false });

            await expect(middleware(request, routeContext(request), async () => { throw failure; })).rejects.toBe(failure);
        });
    });

    it("records an unhandled error as 500 and rethrows it when no error handler converts it", async () => {
        const sink = installFakeSink();
        const failure = new Error("downstream failed");
        const request = new Request("http://api.local/boom", { method: "DELETE" });
        const middleware = apifnWatchMiddleware({ baseUrl: BASE_URL, fireAndForget: false });

        await expect(middleware(request, routeContext(request), async () => { throw failure; })).rejects.toBe(failure);

        expect(sink.events[0]).toMatchObject({ method: "DELETE", path: "/boom", status_code: 500 });
    });
});
