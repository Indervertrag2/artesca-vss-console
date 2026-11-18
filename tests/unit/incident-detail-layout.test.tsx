// @vitest-environment jsdom
//
// The incident dialog's body is a grid item of DialogContent (a CSS grid). With
// the default min-width: auto it cannot shrink below the pixel width Monaco
// (automaticLayout) set on the raw payload editor. Collapsing the payload while
// the dialog's max-width transition was still wide let Monaco grow to that
// width and hold the column there: the clip player stayed ~1100 px wide inside
// a 768 px dialog, clipped. Measured in headless Chromium; jsdom has no layout,
// so this pins the class that lets the column shrink.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import type { Incident } from "@/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/incidents/ClipPlayer", () => ({ ClipPlayer: () => null }));

import { IncidentDetail } from "@/components/incidents/IncidentDetail";

const INCIDENT: Incident = {
  ts: "2026-11-18T10:00:00.000Z",
  scenarioId: "theft",
  scenarioName: "Shelf theft",
  severity: "high",
  sensorId: "camera-1",
  topic: "mdx-vlm",
  summary: "Person conceals an item",
  raw: {},
  clipKey: "",
  clipBucket: "",
  clipStatus: "pending",
};

describe("IncidentDetail layout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false }, { status: 404 })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("lets the dialog body shrink below its content's width, collapsed and expanded", async () => {
    await act(async () => { root.render(<IncidentDetail incident={INCIDENT} onClose={() => {}} />); });
    const body = () =>
      [...document.querySelector('[role="dialog"]')!.children].find((c) =>
        c.textContent?.includes("Raw Payload"),
      )!;
    expect(body().classList).toContain("min-w-0");

    const toggle = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "View entire payload");
    await act(async () => { toggle!.click(); });
    expect(body().textContent).toContain("Collapse");
    expect(body().classList).toContain("min-w-0");
  });
});
