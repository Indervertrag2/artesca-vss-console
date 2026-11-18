// @vitest-environment jsdom
//
// When GET /api/test-footage failed before it had succeeded once, the panel
// rendered neither the file list, nor the empty state, nor an error.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { TestFootagePanel } from "@/components/test-footage/TestFootagePanel";

let footageResponse: () => Response;

describe("TestFootagePanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    footageResponse = () => Response.json({ error: "footage volume not mounted" }, { status: 503 });
    vi.stubGlobal("fetch", vi.fn(async () => footageResponse()));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  it("shows a failed load with a retry", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TestFootagePanel />
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(container.textContent).toContain("could not load test footage");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry, "retry button").toBeTruthy();

    footageResponse = () => Response.json({ files: [], runs: [], maxUploadBytes: 1024 });
    await act(async () => { retry!.click(); });
    await settle();
    expect(container.textContent).toContain("No footage uploaded yet.");
    expect(container.textContent).not.toContain("could not load test footage");
  });
});
