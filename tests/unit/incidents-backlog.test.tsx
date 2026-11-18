// @vitest-environment jsdom
//
// The /incidents backlog (GET /api/incidents) was written into component state
// from inside the queryFn. With staleTime: Infinity a remount within the cache
// time skipped the queryFn and the new component started with an empty list,
// and a failed load was never shown.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/KioskProvider", () => ({ useKiosk: () => ({ kiosk: false }) }));
vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/app/incidents/use-incident-stream", () => ({
  useIncidentStream: () => ({ streamStatus: "connected", sseFailed: false, lastEventAt: null }),
}));

import IncidentsPage from "@/app/incidents/page";

const INCIDENT = {
  ts: new Date().toISOString(),
  scenarioId: "theft",
  scenarioName: "Shelf theft",
  severity: "high",
  sensorId: "camera-1",
  topic: "mdx-vlm",
  summary: "Person conceals an item",
};

let incidentsResponse: () => Response;

describe("/incidents backlog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    incidentsResponse = () => Response.json({ incidents: [INCIDENT] });
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).startsWith("/api/incidents")
        ? incidentsResponse()
        : Response.json({ scenarios: [], warnings: [] }),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount(client: QueryClient) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <IncidentsPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  }

  const rows = () => container.querySelectorAll("tbody tr").length;

  it("shows the cached backlog again after leaving and returning to the page", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await mount(client);
    expect(rows()).toBe(1);

    act(() => root.unmount());
    root = createRoot(container);
    await mount(client);
    expect(rows()).toBe(1);
  });

  it("shows a failed load with a retry that fetches the backlog again", async () => {
    incidentsResponse = () => Response.json({ error: "bridge unreachable" }, { status: 503 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await mount(client);
    expect(container.textContent).toContain("HTTP 503");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry, "retry button").toBeTruthy();

    incidentsResponse = () => Response.json({ incidents: [INCIDENT] });
    await act(async () => { retry!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(rows()).toBe(1);
    expect(container.textContent).not.toContain("HTTP 503");
  });
});
