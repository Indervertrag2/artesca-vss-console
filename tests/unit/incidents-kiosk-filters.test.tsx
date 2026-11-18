// @vitest-environment jsdom
//
// The kiosk wall shows no filter controls, so it must not apply the operator's
// persisted filters (same localStorage key) or the default 1 h time window.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/KioskProvider", () => ({ useKiosk: () => ({ kiosk: true }) }));
vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/app/incidents/use-incident-stream", () => ({
  useIncidentStream: () => ({ streamStatus: "connected", sseFailed: false, lastEventAt: null }),
}));

import IncidentsPage from "@/app/incidents/page";

describe("/incidents kiosk wall", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.setItem(
      "console:incidents:filters:v1",
      JSON.stringify({ scenarios: [], sensors: ["camera-9"], severities: ["high"], timeWindow: "15m" }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).startsWith("/api/incidents")
        ? Response.json({
            incidents: [{
              ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
              scenarioId: "theft",
              scenarioName: "Shelf theft",
              severity: "low",
              sensorId: "camera-1",
              topic: "mdx-vlm",
              summary: "Person conceals an item",
            }],
          })
        : Response.json({ scenarios: [], warnings: [] }),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows a 2 h old incident despite the operator's persisted filters", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <IncidentsPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(container.textContent).toContain("1 incident");
    expect(container.textContent).not.toContain("No incidents yet");
  });
});
