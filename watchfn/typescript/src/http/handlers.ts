import { WatchFn } from "../core/watch-fn";

export class HttpHandlers {
  private watch: WatchFn;

  constructor(watch: WatchFn) {
    this.watch = watch;
  }

  async health() {
    return new Response(JSON.stringify({ status: "ok", version: "0.1.0" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async ingest(request: Request) {
    try {
      const body = await request.json();
      // In a real implementation, we'd validation 'body' and batch ingest
      if (Array.isArray(body)) {
          body.forEach(e => this.watch.track(e.name, e.properties));
      } else {
          this.watch.track(body.name, body.properties);
      }
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  
  async query(request: Request) {
      // Placeholder for query endpoint
      return new Response(JSON.stringify({ results: [] }), {
        headers: { "Content-Type": "application/json" },
      });
  }
}
