// @vitest-environment jsdom
//
// /cameras/sources: the list with status, the event log of the selected source,
// and the add form that shows the token once.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/KioskProvider", () => ({ useKiosk: () => ({ kiosk: false }) }));
vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));

import ExternalSourcesPage from "@/app/cameras/sources/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = {
  id: "till-1",
  name: "till-1",
  type: "till",
  baseUrl: "http://till.example:8181",
  lane: "lane-1",
  mode: "both",
  enabled: true,
  createdAt: "2026-11-18T10:00:00.000Z",
  lastEvent: { event: "purchase_closed", receivedAt: new Date().toISOString(), sessionId: 63 },
  health: { reachable: true, status: 200, clockOffsetMs: -100 },
  pull: { lastPollAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), added: 0 },
};

const EVENTS = {
  events: [
    { id: 2, receivedAt: "2026-11-18T17:43:34.000Z", event: "purchase_closed", ts: "2026-11-18T17:43:33Z", seq: 1046, lane: "lane-1", gap: 0, payload: { session_id: 63, items: [{}, {}, {}], total_cents: 500 } },
    { id: 1, receivedAt: "2026-11-18T17:43:30.000Z", event: "item_scanned", ts: "2026-11-18T17:43:29Z", seq: 1043, lane: "lane-1", gap: 2, payload: { session_id: 63, ean: "87126853" } },
  ],
  counts: { purchase_closed: 1, item_scanned: 1 },
  gaps: 2,
};

describe("/cameras/sources", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const added = { ...SOURCE, id: "lane-2-till", name: "lane-2-till", mode: "push", lastEvent: null };
    let created = false;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/sources" && init?.method === "POST") {
        created = true;
        return Response.json({ source: added, token: "tok-123" }, { status: 201 });
      }
      if (url === "/api/sources") return Response.json({ sources: created ? [SOURCE, added] : [SOURCE], warnings: [] });
      if (url.startsWith("/api/sources/till-1/events")) return Response.json(EVENTS);
      return Response.json({ events: [], counts: {}, gaps: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ExternalSourcesPage />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 20 && !container.textContent?.includes("1046"); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }
  };

  it("lists the source with its status and shows its event log and input address", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("reachable");
    expect(text).toContain("clock offset −0.1 s");
    expect(text).toContain("pull ok");
    expect(text).toContain("purchase #63");
    // Event log: the row, its details, and the gap before seq 1043.
    expect(text).toContain("1046");
    expect(text).toContain("3 items · total 5.00");
    expect(text).toContain("2 events missing before seq 1043");
    expect(text).toContain("seq gaps: 2 missing");
    // Event input, with the token as a placeholder: it is shown only once.
    expect(text).toContain("/api/sources/till-1/events");
    expect(text).toContain("Bearer <token>");
  });

  it("filters the log by event type", async () => {
    await render();
    const chip = [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("item_scanned"))!;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("&type=item_scanned"))).toBe(true);
  });

  it("adds a source and shows its token once", async () => {
    await render();
    const name = container.querySelector<HTMLInputElement>('input[placeholder="e.g. lane-2-till"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "lane-2-till");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    for (let i = 0; i < 20 && !container.textContent?.includes("tok-123"); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }
    const post = fetchMock.mock.calls.find(([u, init]) => u === "/api/sources" && init?.method === "POST");
    expect(JSON.parse(post![1].body)).toMatchObject({ name: "lane-2-till", type: "till", mode: "push", enabled: true });
    expect(container.textContent).toContain("Bearer tok-123");
    expect(container.textContent).toContain("It is not shown again");
  });
});
