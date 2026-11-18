// @vitest-environment jsdom
//
// /api/incidents/live starts every connection with an empty seen-set and only
// records its first poll. An incident raised while the stream was down sits in
// that first poll, so the page must fetch the backlog again when a connection
// opens, or the incident never shows until a reload.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/KioskProvider", () => ({ useKiosk: () => ({ kiosk: false }) }));
vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));

import IncidentsPage from "@/app/incidents/page";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {}
}

const incident = (sensorId: string) => ({
  ts: new Date().toISOString(),
  scenarioId: "theft",
  scenarioName: "Shelf theft",
  severity: "low",
  sensorId,
  topic: "mdx-vlm",
  summary: "Person conceals an item",
});

let backlog: unknown[];

describe("/incidents live stream reconnect", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    FakeEventSource.instances = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    backlog = [incident("camera-1")];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).startsWith("/api/incidents")
        ? Response.json({ incidents: backlog })
        : Response.json({ scenarios: [], warnings: [] }),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  const rows = () => container.querySelectorAll("tbody tr").length;

  it("shows an incident raised while the stream was reconnecting", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <IncidentsPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => { FakeEventSource.instances[0].onopen?.(); });
    await settle();
    expect(rows()).toBe(1);

    // The stream drops; an incident is raised before it reconnects (1 s back-off).
    act(() => FakeEventSource.instances[0].onerror?.());
    backlog = [incident("camera-2"), ...backlog];
    await act(async () => { await new Promise((r) => setTimeout(r, 1_100)); });
    expect(FakeEventSource.instances).toHaveLength(2);

    await act(async () => { FakeEventSource.instances[1].onopen?.(); });
    await settle();
    expect(rows()).toBe(2);
  });
});
