// @vitest-environment jsdom
//
// /api/analytics counts categories over all cameras only. A question naming a
// category and a camera must not present the all-camera category count as the
// count for that camera.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => children }));

import AnalyticsPage from "@/app/analytics/page";

describe("/analytics Ask the store", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({
        total: 20,
        byCategory: { "self-checkout-theft": 12 },
        byCamera: { "checkout-1": 5, "aisle-1": 15 },
        byDay: [],
      }),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function ask(question: string) {
    await act(async () => { root.render(<AnalyticsPage />); });
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, question);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return container.querySelector("p.text-lg")!.textContent!;
  }

  it("says the category count covers all cameras when the question names a camera", async () => {
    const text = await ask("how many thefts on checkout-1 this week");
    expect(text).not.toContain("12 self checkout theft incidents on checkout-1");
    expect(text).toContain("12 self checkout theft incidents across all cameras in the last 7 days");
    expect(text).toContain("5 incidents of any category on checkout-1");
  });

  it("answers a category question without a camera as before", async () => {
    const text = await ask("how many thefts this week");
    expect(text).toBe("12 self checkout theft incidents in the last 7 days.");
  });
});
