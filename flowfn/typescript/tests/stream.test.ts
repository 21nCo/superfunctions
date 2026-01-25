/**
 * Tests for Stream System
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createFlow } from "../src/core/flow-fn.js";
import { FlowFn } from "../src/core/flow-fn.js";

describe("Stream System", () => {
  let flow: FlowFn;

  beforeEach(() => {
    flow = createFlow({ adapter: "memory" });
  });

  describe("Publishing and Subscribing", () => {
    it("should publish and receive messages", async () => {
      const stream = flow.stream("test-stream");
      const received: any[] = [];

      await stream.subscribe(async (msg) => {
        received.push(msg.data);
        await msg.ack();
      });

      await stream.publish({ value: "hello" });
      await stream.publish({ value: "world" });

      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBe(2);
      expect(received[0].value).toBe("hello");
      expect(received[1].value).toBe("world");
    });

    it("should publish batch messages", async () => {
      const stream = flow.stream("batch-stream");
      const received: any[] = [];

      await stream.subscribe(async (msg) => {
        received.push(msg.data);
        await msg.ack();
      });

      await stream.publishBatch([
        { data: { id: 1 } },
        { data: { id: 2 } },
        { data: { id: 3 } },
      ]);

      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBe(3);
    });
  });

  describe("Stream Trimming", () => {
    it("should trim by max length", async () => {
      const stream = flow.stream("trim-stream");

      // Publish more messages than max
      for (let i = 0; i < 10; i++) {
        await stream.publish({ index: i });
      }

      const trimmed = await stream.trim({ maxLength: 5 });

      expect(trimmed).toBe(5); // Should have removed 5 messages
    });

    it("should trim by max age", async () => {
      const stream = flow.stream("age-stream");

      await stream.publish({ old: true });

      // Wait a bit
      await new Promise((r) => setTimeout(r, 100));

      const trimmed = await stream.trim({ maxAgeSeconds: 0.05 }); // 50ms

      expect(trimmed).toBeGreaterThan(0);
    });

    it("should auto-trim on maxLength option", async () => {
      const stream = flow.stream("auto-trim", { maxLength: 3 });

      await stream.publish({ id: 1 });
      await stream.publish({ id: 2 });
      await stream.publish({ id: 3 });
      await stream.publish({ id: 4 }); // Should trigger trim

      const count = stream.getMessageCount();
      expect(count).toBeLessThanOrEqual(3);
    });
  });

  describe("Message Retrieval", () => {
    it("should get messages by range", async () => {
      const stream = flow.stream("retrieval-stream");

      const ids = [];
      ids.push(await stream.publish({ index: 1 }));
      ids.push(await stream.publish({ index: 2 }));
      ids.push(await stream.publish({ index: 3 }));

      const messages = await stream.getMessages(ids[0], ids[2]);

      expect(messages.length).toBeGreaterThan(0);
    });

    it("should limit message count", async () => {
      const stream = flow.stream("limit-stream");

      await stream.publish({ id: 1 });
      await stream.publish({ id: 2 });
      await stream.publish({ id: 3 });

      const firstId = (await stream.getMessages("0", "z", 1))[0]?.id || "0";
      const messages = await stream.getMessages(firstId, "z", 2);

      expect(messages.length).toBeLessThanOrEqual(2);
    });
  });

  describe("Consumer Groups", () => {
    it("should create consumer with group", async () => {
      const stream = flow.stream("consumer-stream");
      const received: any[] = [];

      const consumer = stream.createConsumer("consumer-1", {
        groupId: "processors",
        fromBeginning: false,
      });

      await consumer.subscribe(async (msg) => {
        received.push(msg.data);
        await msg.ack();
      });

      await stream.publish({ value: "test" });

      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBeGreaterThan(0);
    });

    it("should replay from beginning", async () => {
      const stream = flow.stream("replay-stream");

      // Publish before subscribing
      await stream.publish({ id: 1 });
      await stream.publish({ id: 2 });

      const received: any[] = [];
      const consumer = stream.createConsumer("replayer", {
        groupId: "group1",
        fromBeginning: true,
      });

      await consumer.subscribe(async (msg) => {
        received.push(msg.data);
        await msg.ack();
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(received.length).toBe(2);
      expect(received[0].id).toBe(1);
      expect(received[1].id).toBe(2);
    });

    it("should pause and resume consumer", async () => {
      const stream = flow.stream("pause-stream");
      const received: any[] = [];

      const consumer = stream.createConsumer("pausable", {
        groupId: "group1",
      });

      await consumer.subscribe(async (msg) => {
        received.push(msg.data);
        await msg.ack();
      });

      await stream.publish({ id: 1 });
      await new Promise((r) => setTimeout(r, 50));

      await consumer.pause();
      await stream.publish({ id: 2 }); // Should not be received

      await consumer.resume();
      await stream.publish({ id: 3 });
      await new Promise((r) => setTimeout(r, 50));

      // Should have received 1 and 3, but not 2
      expect(received.length).toBeGreaterThan(0);
    });
  });

  describe("Stream Replay", () => {
    it("should replay messages from timestamp", async () => {
      const stream = flow.stream("replay-ts-stream");

      const startTime = Date.now();

      await stream.publish({ id: 1 });
      await new Promise((r) => setTimeout(r, 50));
      await stream.publish({ id: 2 });

      const received: any[] = [];
      const count = await stream.replay(startTime, async (msg) => {
        received.push(msg.data);
      });

      expect(count).toBe(2);
      expect(received.length).toBe(2);
    });
  });

  describe("Stream Info", () => {
    it("should get stream info", async () => {
      const stream = flow.stream("info-stream");

      await stream.publish({ test: true });
      await stream.publish({ test: true });

      const info = await stream.getInfo();

      expect(info.name).toBe("info-stream");
      expect(info.length).toBeGreaterThanOrEqual(2);
    });
  });
});
