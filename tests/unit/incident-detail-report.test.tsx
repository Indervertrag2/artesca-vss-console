// @vitest-environment jsdom
//
// IncidentDetail stays mounted while the operator moves between incidents. A
// Generate Report still in flight for incident A must not land in the dialog
// once it shows incident B.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import type { Incident } from "@/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));
// Monaco is not under test; the raw payload editor renders nothing.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/incidents/ClipPlayer", () => ({ ClipPlayer: () => null }));

import { IncidentDetail } from "@/components/incidents/IncidentDetail";

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

describe("IncidentDetail Generate Report", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resolvePost: (r: Response) => void;

  beforeEach(() => {
    toastMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => { resolvePost = resolve; })
        : Promise.resolve(Response.json({ ok: false }, { status: 404 })),
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (inc: Incident | null) =>
    act(async () => { root.render(<IncidentDetail incident={inc} onClose={() => {}} />); });

  it("drops the report of an incident the dialog no longer shows", async () => {
    await render(incident("camera-1"));
    const button = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("Generate Report"));
    expect(button, "Generate Report button").toBeTruthy();
    await act(async () => { button!.click(); });

    await render(null);
    await render(incident("camera-2"));
    await act(async () => {
      resolvePost(Response.json({ ok: true, markdown: "Report for camera-1", frames: [] }));
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(document.body.textContent).toContain("camera-2");
    expect(document.body.textContent).not.toContain("Report for camera-1");
    expect(toastMock).not.toHaveBeenCalled();
  });
});
