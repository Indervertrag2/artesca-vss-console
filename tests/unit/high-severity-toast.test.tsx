// @vitest-environment jsdom
//
// Each kiosk high-severity banner dismisses itself after 8 s. The timer lived in
// an effect keyed on the trigger, so a second alert within 8 s cleared the first
// banner's timer and that banner stayed on the unattended display.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import type { Incident } from "@/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { HighSeverityToast } from "@/components/incidents/HighSeverityToast";

const incident = (sensorId: string): Incident => ({
  ts: "2026-11-18T10:00:00.000Z",
  scenarioId: "theft",
  scenarioName: "Shelf theft",
  severity: "high",
  sensorId,
  topic: "mdx-vlm",
  summary: "Person conceals an item",
  raw: {},
  clipKey: "",
  clipBucket: "",
  clipStatus: "pending",
});

describe("HighSeverityToast", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("dismisses the first banner on time when a second alert follows within 8 s", () => {
    act(() => root.render(<HighSeverityToast triggerIncident={incident("camera-1")} />));
    act(() => vi.advanceTimersByTime(2_000));
    act(() => root.render(<HighSeverityToast triggerIncident={incident("camera-2")} />));
    expect(container.textContent).toContain("camera-1");
    expect(container.textContent).toContain("camera-2");

    act(() => vi.advanceTimersByTime(6_100));
    expect(container.textContent).not.toContain("camera-1");
    expect(container.textContent).toContain("camera-2");

    act(() => vi.advanceTimersByTime(2_000));
    expect(container.textContent).toBe("");
  });
});
