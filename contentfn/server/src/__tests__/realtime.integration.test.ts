import { describe, it, expect, beforeEach, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import type { RealtimeServerMessage, RealtimeEventMessage } from "../realtime/protocol.js";
import type { Adapter } from "@superfunctions/db";
import type { AuthorizeFn } from "../realtime/server.js";

const schemaV1 = {
  version: 1,
  documentTypes: [
    {
      name: "post",
      fields: [
        { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
        { name: "views", type: { kind: "primitive" as const, type: "number" as const }, required: false },
      ],
    },
  ],
};

describe("PHASE_10 realtime feed", () => {
  let db: Adapter;

  describe("TV-RT-SUBSCRIBE-001: subscribe to doc events", () => {
    it("receives event messages on publish with required fields", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
        docId: "post-3",
      }));

      expect(received.length).toBe(1);
      expect(received[0].type).toBe("subscribe_ack");
      const ack = received[0] as { type: string; dataset: string; docId?: string };
      expect(ack.dataset).toBe("prod");
      expect(ack.docId).toBe("post-3");

      received.length = 0;

      await api.docs.create({
        dataset: "prod",
        id: "post-3",
        type: "post",
        asDraft: true,
        doc: { title: "Live Preview" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-3" });

      expect(received.length).toBe(1);
      const evt = received[0] as RealtimeEventMessage;
      expect(evt.type).toBe("event");
      expect(evt.eventId).toBeDefined();
      expect(typeof evt.eventId).toBe("string");
      expect(evt.dataset).toBe("prod");
      expect(evt.timestamp).toBeDefined();
      expect(typeof evt.timestamp).toBe("string");
      expect(evt.eventType).toBe("doc.published");
      expect(evt.document).toBeDefined();
      expect(evt.document!._id).toBe("post-3");

      conn.disconnect();
    });

    it("receives events for dataset-level subscription", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
      }));

      expect(received.length).toBe(1);
      expect(received[0].type).toBe("subscribe_ack");

      received.length = 0;

      await api.docs.create({
        dataset: "prod",
        id: "post-ds",
        type: "post",
        asDraft: true,
        doc: { title: "DS Test" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-ds" });

      expect(received.map(message => (message as RealtimeEventMessage).eventType)).toEqual(["doc.created", "doc.published"]);
      const evt = received[1] as RealtimeEventMessage;
      expect(evt.eventType).toBe("doc.published");
      expect(evt.document!._id).toBe("post-ds");

      conn.disconnect();
    });

    it("does not receive events for unrelated documents", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
        docId: "post-3",
      }));

      received.length = 0;

      await api.docs.create({
        dataset: "prod",
        id: "post-other",
        type: "post",
        asDraft: true,
        doc: { title: "Other" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-other" });

      expect(received.length).toBe(0);

      conn.disconnect();
    });

    it("does not receive events for unrelated datasets", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.datasets.create({ dataset: "staging" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
      await api.schema.upsert({ dataset: "staging", schema: schemaV1 });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
      }));

      received.length = 0;

      await api.docs.create({
        dataset: "staging",
        id: "post-s1",
        type: "post",
        asDraft: true,
        doc: { title: "Staging" },
      });

      await api.docs.publish({ dataset: "staging", id: "post-s1" });

      expect(received.length).toBe(0);

      conn.disconnect();
    });
  });

  describe("TV-RT-SUBSCRIBE-002: unauthorized subscribe", () => {
    it("returns PERMISSION_DENIED when authorization denies subscribe", async () => {
      db = memoryAdapter();
      const authorize: AuthorizeFn = async (_ctx, action, _input) => {
        if (action === "realtime.subscribe") return false;
        return true;
      };

      const server = createContentfnServer({ db, authorize });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
        docId: "post-3",
      }));

      expect(received.length).toBe(1);
      expect(received[0].type).toBe("error");
      const errMsg = received[0] as { type: string; code: string; message: string };
      expect(errMsg.code).toBe("PERMISSION_DENIED");

      conn.disconnect();
    });

    it("does not send events after authorization denial", async () => {
      db = memoryAdapter();
      const authorize: AuthorizeFn = async (_ctx, action, _input) => {
        if (action === "realtime.subscribe") return false;
        return true;
      };

      const server = createContentfnServer({ db, authorize });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
      }));

      expect(received[0].type).toBe("error");
      received.length = 0;

      await api.docs.create({
        dataset: "prod",
        id: "post-denied",
        type: "post",
        asDraft: true,
        doc: { title: "Denied" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-denied" });

      expect(received.length).toBe(0);

      conn.disconnect();
    });
  });

  describe("TV-RT-EVENTS-001: publish emits doc.published", () => {
    it("receives doc.published event when subscribed to dataset events", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
      }));

      received.length = 0;

      await api.docs.create({
        dataset: "prod",
        id: "post-pub",
        type: "post",
        asDraft: true,
        doc: { title: "Published" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-pub" });

      expect(received.map(message => (message as RealtimeEventMessage).eventType)).toEqual(["doc.created", "doc.published"]);
      const evt = received[1] as RealtimeEventMessage;
      expect(evt.type).toBe("event");
      expect(evt.eventType).toBe("doc.published");
      expect(evt.dataset).toBe("prod");
      expect(evt.document!._id).toBe("post-pub");
      expect(evt.eventId).toBeDefined();
      expect(evt.timestamp).toBeDefined();

      conn.disconnect();
    });

    it("receives doc.unpublished event", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      await api.docs.create({
        dataset: "prod",
        id: "post-unpub",
        type: "post",
        asDraft: true,
        doc: { title: "Unpub" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-unpub" });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
      }));

      received.length = 0;

      await api.docs.unpublish({ dataset: "prod", id: "post-unpub" });

      expect(received.length).toBe(1);
      const evt = received[0] as RealtimeEventMessage;
      expect(evt.type).toBe("event");
      expect(evt.eventType).toBe("doc.unpublished");
      expect(evt.document!._id).toBe("post-unpub");

      conn.disconnect();
    });
  });

  describe("unsubscribe", () => {
    it("stops receiving events after unsubscribe", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
      }));

      await conn.handleMessage(JSON.stringify({
        type: "unsubscribe",
        dataset: "prod",
      }));

      expect(received.length).toBe(2);
      expect(received[1].type).toBe("unsubscribe_ack");
      received.length = 0;

      await api.docs.create({
        dataset: "prod",
        id: "post-unsub",
        type: "post",
        asDraft: true,
        doc: { title: "Unsub" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-unsub" });

      expect(received.length).toBe(0);

      conn.disconnect();
    });
  });

  describe("connection management", () => {
    it("disconnect removes connection and stops events", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const api = server.api;
      const rt = server.realtime;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage(JSON.stringify({
        type: "subscribe",
        dataset: "prod",
      }));

      conn.disconnect();
      received.length = 0;

      await api.docs.create({
        dataset: "prod",
        id: "post-disc",
        type: "post",
        asDraft: true,
        doc: { title: "Disc" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-disc" });

      expect(received.length).toBe(0);
    });

    it("tracks connection count", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const rt = server.realtime;

      expect(rt.getConnectionCount()).toBe(0);

      const conn1 = rt.createConnection(() => {});
      expect(rt.getConnectionCount()).toBe(1);

      const conn2 = rt.createConnection(() => {});
      expect(rt.getConnectionCount()).toBe(2);

      conn1.disconnect();
      expect(rt.getConnectionCount()).toBe(1);

      conn2.disconnect();
      expect(rt.getConnectionCount()).toBe(0);
    });
  });

  describe("invalid messages", () => {
    it("returns error for malformed messages", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });
      const rt = server.realtime;

      const received: RealtimeServerMessage[] = [];
      const conn = rt.createConnection((msg) => received.push(msg));

      await conn.handleMessage("not-json");

      expect(received.length).toBe(1);
      expect(received[0].type).toBe("error");
      const errMsg = received[0] as { type: string; code: string };
      expect(errMsg.code).toBe("VALIDATION_FAILED");

      conn.disconnect();
    });
  });
});
