// @vitest-environment jsdom
//
// OverviewAutoRefresh polled /api/status/overview (a full collectOverviewSnapshot)
// every 5 s only to call router.refresh() afterwards, which re-renders the page
// and collects the snapshot again: every refresh probed the cluster twice.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { OverviewAutoRefresh } from "@/components/overview/OverviewAutoRefresh";

describe("OverviewAutoRefresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  const refresh = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockReset();
    fetchMock.mockReset();
    vi.mocked(useRouter).mockReturnValue({ refresh } as unknown as ReturnType<typeof useRouter>);
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(
      <QueryClientProvider client={client}>
        <OverviewAutoRefresh />
      </QueryClientProvider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refreshes the server render every 5 s without collecting the snapshot itself", () => {
    act(() => vi.advanceTimersByTime(10_100));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not refresh while the tab is hidden", () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      act(() => vi.advanceTimersByTime(10_100));
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });
});
