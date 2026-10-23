/**
 * PHASE_12: Audit panes — TV-DESK-PANES-002 (webhook/audit pane), no-access state.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EventsPane } from "../panes/audit/EventsPane.js";
import { WebhooksPane } from "../panes/audit/WebhooksPane.js";

const API_URL = "http://cmsfn.test";

describe("PHASE_12: Audit panes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-DESK-PANES-002: webhook/audit pane shows delivery attempts", () => {
    it("WebhooksPane requests CmsFn audit and renders deliveries deterministically", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.includes("/cmsfn/audit/webhooks")) {
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  deliveries: [
                    {
                      webhookId: "wh-1",
                      dataset: "prod",
                      url: "https://example.com/hook",
                      eventId: "evt-1",
                      attempt: 1,
                      status: "delivered",
                      updatedAt: "2026-02-11T12:00:00Z",
                    },
                  ],
                  nextCursor: null,
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ ok: false }), { status: 404 });
        })
      );

      render(<WebhooksPane cmsfnApiUrl={API_URL} dataset="prod" />);
      await waitFor(() => expect(document.querySelector("[data-audit-webhooks-list]")).toBeDefined());
      expect(document.querySelector("[data-audit-delivery]")).toBeDefined();
      expect(screen.getByText("delivered")).toBeDefined();
    });
  });

  it("shows unknown legacy time and processing state without inventing a timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {
      deliveries: [{ webhookId: "deleted", dataset: "prod", url: null, eventId: "legacy", attempt: 2, status: "processing", updatedAt: null, timestampKnown: false }], nextCursor: null,
    } }))));
    render(<WebhooksPane cmsfnApiUrl={API_URL} dataset="prod" />);
    await waitFor(() => expect(screen.getByText("Timestamp unknown")).toBeDefined());
    expect(screen.getByText("processing")).toBeDefined();
  });

  it("renders authoritative audit targets without inventing document fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {
      events: [{ eventId: "audit-1", dataset: "prod", type: "docs.publish", timestamp: "2026-10-23T00:00:00Z", targetIds: ["prod", "article-1"] }], nextCursor: null,
    } }))));
    render(<EventsPane cmsfnApiUrl={API_URL} dataset="prod" />);
    await waitFor(() => expect(screen.getByText("prod, article-1")).toBeDefined());
    expect(document.querySelector("[data-audit-event-doc-id]")).toBeNull();
  });

  describe("TV-DESK-PANES-002 negative: no audit.read shows no access", () => {
    it("EventsPane with hasAuditRead=false shows deterministic no access", () => {
      render(<EventsPane cmsfnApiUrl={API_URL} dataset="prod" hasAuditRead={false} />);
      expect(document.querySelector("[data-audit-events-pane][data-audit-denied]")).toBeDefined();
      expect(document.querySelector("[data-audit-denied-message]")).toBeDefined();
      expect(screen.getByText(/no access/i)).toBeDefined();
    });

    it("WebhooksPane with hasAuditRead=false shows deterministic no access", () => {
      render(<WebhooksPane cmsfnApiUrl={API_URL} dataset="prod" hasAuditRead={false} />);
      expect(document.querySelector("[data-audit-webhooks-pane][data-audit-denied]")).toBeDefined();
      expect(screen.getByText(/no access/i)).toBeDefined();
    });
  });
});
