// @vitest-environment jsdom
//
// The Evidence section of the multi-camera form (issue #60): live alerts or the
// recording of the purchase, and for the recording the chunk settings, the
// question and an optional crop per camera.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { MultiCameraConfig } from "@/components/scenarios/MultiCameraConfig";
import { DEFAULT_QUESTION, DEFAULT_RULES } from "@/lib/purchase-judge";
import type { Scenario } from "@/lib/types";

const BASE: Scenario = {
  id: "sco",
  name: "Self-checkout",
  severity: "high",
  channels: ["ui"],
  sensorFilter: "*",
  keywords: [],
  enabled: true,
  mode: "multi",
  cameras: [{ id: "overhead-cam" }, { id: "scanner-cam" }],
  sources: [{ id: "till-1", role: "clock" }],
  rules: DEFAULT_RULES,
};

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

describe("multi-camera form: evidence", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn<(s: Scenario) => void>();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onChange.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (scenario: Scenario) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <MultiCameraConfig scenario={scenario} onChange={onChange} cameraIds={[]} sourceIds={[]} />
        </QueryClientProvider>,
      );
    });
  const named = <T extends Field>(label: string) => container.querySelector<T>(`[aria-label="${label}"]`);
  const labelled = (text: string) =>
    [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith(text))!.querySelector("input")!;
  const enter = (el: Field, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  const last = () => onChange.mock.lastCall![0];

  it("offers live alerts by default, without the recording settings", async () => {
    await render(BASE);
    const evidence = named<HTMLSelectElement>("Evidence")!;
    expect(evidence.value).toBe("live");
    expect([...evidence.options].map((o) => o.textContent)).toEqual(["Live alerts", "Recording of the purchase"]);
    expect(named("Question")).toBeNull();
    expect(container.textContent).not.toContain("Chunk length");

    await enter(evidence, "recording");
    expect(last()).toEqual({ ...BASE, evidence: "recording" });
  });

  it("shows the defaults for a recording and writes each setting to the scenario", async () => {
    await render({ ...BASE, evidence: "recording" });
    expect(labelled("Chunk length").value).toBe("10");
    expect(labelled("Overlap").value).toBe("4");
    expect(labelled("Frames per second").value).toBe("4");
    expect(named<HTMLTextAreaElement>("Question")!.value).toBe(DEFAULT_QUESTION);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await enter(labelled("Chunk length"), "8");
    expect(last()).toMatchObject({ evidence: "recording", chunkS: 8 });
    await enter(labelled("Overlap"), "2");
    expect(last()).toMatchObject({ overlapS: 2 });
    await enter(labelled("Frames per second"), "6");
    expect(last()).toMatchObject({ framesPerSecond: 6 });
    await enter(named("Question")!, "Question: is a product carried away?");
    expect(last()).toMatchObject({ question: "Question: is a product carried away?" });
    await enter(named("System prompt")!, "You watch a self-checkout.");
    expect(last()).toMatchObject({ systemPrompt: "You watch a self-checkout." });

    // Back to live alerts: the scenario is live again, as one that never had the field.
    await enter(named("Evidence")!, "live");
    expect(last().evidence).toBeUndefined();
  });

  it("says in the form why a setting cannot be used", async () => {
    await render({ ...BASE, evidence: "recording", chunkS: 16 });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("64 frames per request; the model takes at most 60");
    await render({ ...BASE, evidence: "recording", question: "" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("question to the model is empty");
  });

  it("takes an optional crop per camera and drops it when its fields are emptied", async () => {
    await render({ ...BASE, evidence: "recording" });
    await enter(named("Crop width of overhead-cam")!, "1100");
    expect(last().cameras).toEqual([{ id: "overhead-cam", crop: { x: 0, y: 0, width: 1100, height: 0 } }, { id: "scanner-cam" }]);

    const cropped = { ...BASE, evidence: "recording" as const, cameras: last().cameras };
    await render(cropped);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("crop of camera overhead-cam needs a width and a height");
    expect(named<HTMLInputElement>("Crop width of overhead-cam")!.value).toBe("1100");
    expect(named<HTMLInputElement>("Crop x of scanner-cam")!.value).toBe("");

    await enter(named("Crop width of overhead-cam")!, "");
    expect(last().cameras).toEqual(BASE.cameras);
  });
});
