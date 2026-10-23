import { describe, it, expect } from "vitest";
import { watchFn } from "../src";

describe("watchFn", () => {
  it("should initialize with minimal config", () => {
    const watch = watchFn({ name: "test-app" });
    expect(watch).toBeDefined();
  });

  it("should start and stop", () => {
    const watch = watchFn({ name: "test-app" });
    watch.start();
    watch.stop();
  });
  
  it("should track events", () => {
      const watch = watchFn({ name: "test-app" });
      watch.start();
      watch.track("test.event", { foo: "bar" });
      watch.stop();
  });

  it("should store and query events in memory", async () => {
    const watch = watchFn({ name: "test-app", storage: "memory" });
    watch.start();
    watch.track("test.event.stored", { value: 123 });
    
    // Give it a moment to process (though it's sync in this impl)
    await new Promise(r => setTimeout(r, 10));
    
    const results = await watch.query({ 
      metric: "test.event.stored",
      where: {
        value: { gt: 100 },
        tags: { exists: false }
      }
    });
    expect(results.length).toBe(1);
    expect(results[0].properties.value).toBe(123);
    
    const noResults = await watch.query({
      metric: "test.event.stored",
      where: {
        value: { lt: 100 }
      }
    });
    expect(noResults.length).toBe(0);
    
    watch.stop();
  });

  it("should capture breadcrumbs and exceptions", async () => {
    const watch = watchFn({ name: "test-app", storage: "memory" });
    watch.start();
    
    watch.errors.addBreadcrumb({
      type: "user",
      message: "User clicked login",
    });
    
    watch.captureException(new Error("Login failed"), { userId: "123" });
    
    await new Promise(r => setTimeout(r, 10));
    
    const errors = await watch.query({ metric: "error" }); // In our stub impl it returns all if not matched or we can improve query
    
    const errorEvent = (await watch.query({})).find(e => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toBe("Login failed");
    expect(watch.errors.getBreadcrumbs().length).toBe(1);
    expect(watch.errors.getBreadcrumbs()[0].message).toBe("User clicked login");
    
    watch.stop();
  });

  it("should intercept fetch calls and track them", async () => {
    // Mock global fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200,
      ok: true,
      json: async () => ({ success: true }),
    }) as any;

    const watch = watchFn({ 
      name: "test-app", 
      storage: "memory",
      apm: { enabled: true, autoInstrument: { http: true } } as any
    });
    watch.start();

    await fetch("https://api.example.com/data");

    await new Promise(r => setTimeout(r, 10));

    const results = await watch.query({});
    const fetchEvent = results.find(e => e.name === "http.client.request");
    
    expect(fetchEvent).toBeDefined();
    expect(fetchEvent.properties.url).toBe("https://api.example.com/data");
    expect(fetchEvent.properties.statusCode).toBe(200);

    watch.stop();
    globalThis.fetch = originalFetch;
  });

  it("should create and record traces", async () => {
    const watch = watchFn({ name: "test-app", storage: "memory" });
    watch.start();

    await watch.trace.start("parent-operation", async (span) => {
        span.setTag("env", "test");
        
        // Simulate async work
        await new Promise(r => setTimeout(r, 10));
        
        // Nested span
        await watch.trace.start("child-operation", async (childSpan) => {
             // Should have parentId from parent-operation
             expect(childSpan.parentId).toBe(span.id);
             expect(childSpan.traceId).toBe(span.traceId);
        });
    });
    
    // Give it a tick to process
    await new Promise(r => setTimeout(r, 10));

    const events = await watch.query({});
    const spans = events.filter(e => e.name === "trace.span");
    
    expect(spans.length).toBe(2);
    
    const parent = spans.find(s => s.properties.name === "parent-operation");
    const child = spans.find(s => s.properties.name === "child-operation");
    
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child.properties.parentId).toBe(parent.properties.id);
    expect(child.properties.traceId).toBe(parent.properties.traceId);
    
    watch.stop();
  });

  it("should collect infrastructure metrics", async () => {
    const watch = watchFn({ 
      name: "test-app", 
      storage: "memory",
      infra: { enabled: true, interval: 10 } // Short interval for testing
    });
    watch.start();
    
    // Wait for at least one collection cycle
    await new Promise(r => setTimeout(r, 100));
    
    const events = await watch.query({});
    const systemMetrics = events.find(e => e.name === "infra.system");
    const processMetrics = events.find(e => e.name === "infra.process");
    
    expect(systemMetrics).toBeDefined();
    expect(systemMetrics.properties.memory_usage).toBeDefined();
    
    expect(processMetrics).toBeDefined();
    expect(processMetrics.properties.pid).toBe(process.pid);
    
    watch.stop();
  });

  it("should use database storage when configured", async () => {
      const mockDb = {
          insertEvent: async (e: any) => {},
          queryEvents: async (opts: any) => [{ name: "db.event", properties: { saved: true } }]
      };
      
      const watch = watchFn({ 
          name: "db-app", 
          storage: "database",
          database: mockDb
      });
      watch.start();
      watch.track("db.event", { saved: true });
      
      const results = await watch.query({ metric: "db.event" });
      expect(results.length).toBe(1);
      expect(results[0].properties.saved).toBe(true);
      
      watch.stop();
  });

  it("should run synthetic checks", async () => {
    // Mock fetch for synthetics
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 200,
      text: async () => "healthy",
      headers: new Headers(),
    }) as any;

    const watch = watchFn({ name: "test-app", storage: "memory" });
    watch.start();
    
    await watch.synthetics.create({
        name: "health-check",
        type: "http",
        url: "https://api.example.com/health",
        interval: 1000,
        assertions: [
            { type: "status", operator: "eq", value: 200 },
            { type: "body", operator: "contains", value: "healthy" }
        ]
    });
    
    // Wait for execution (it runs immediately on create)
    await new Promise(r => setTimeout(r, 10));
    
    const events = await watch.query({ metric: "synthetics.check" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].properties.success).toBe(true);
    expect(events[0].properties.response.status).toBe(200);
    
    watch.stop();
    globalThis.fetch = originalFetch;
  });
});
