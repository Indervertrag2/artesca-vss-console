// Hints from the recording of a purchase (issue #60): each camera's recording of
// the purchase window is downloaded from VST, re-encoded once, cut into
// overlapping chunks, and every chunk is put to the VLM as a file, one at a time.
// VST, the VLM and ffmpeg are mocked; the temp files are real.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ff = vi.hoisted(() => ({ calls: [] as string[][], frames: 930 }));
vi.mock("@/lib/streams/ffmpeg", async () => {
  const { writeFileSync } = await import("fs");
  return {
    spawnFfmpeg: vi.fn(async (args: string[]) => {
      ff.calls.push(args);
      writeFileSync(args.at(-1)!, "mp4");
      return { code: 0, stderr: `frame=  100 fps= 56 q=27.0 size=1KiB\rframe=  ${ff.frames} fps= 57 q=-1.0 Lsize=    7959KiB time=00:01:02.00` };
    }),
  };
});
vi.mock("@/lib/streams/vst-clip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/streams/vst-clip")>()),
  resolveStreamId: async (name: string) => (name === "unknown-cam" ? null : `stream-${name}`),
}));

import { recordingHints, RecordingUnavailableError } from "@/lib/purchase-recording";
import { DEFAULT_QUESTION, DEFAULT_SYSTEM_PROMPT, type ScenarioMulti } from "@/lib/purchase-judge";

const WINDOW = { start: "2026-11-18T17:42:51.000Z", end: "2026-11-18T17:43:53.000Z" }; // 62 s: 10 chunks
const THEFT = "Yes - snack packet - placed on the counter next to the scanner instead of scanning it";
const SCENARIO: ScenarioMulti = {
  mode: "multi",
  evidence: "recording",
  cameras: [{ id: "overhead-cam", crop: { x: 400, y: 200, width: 1100, height: 620 } }, { id: "scanner-cam" }],
};

/** What the mocked VST and VLM saw, and how they answer. */
const vlm = {
  events: [] as string[],
  downloads: [] as URL[],
  uploads: [] as FormData[],
  chats: [] as Record<string, unknown>[],
  active: 0,
  maxActive: 0,
  /** The answer to the n-th question (0-based), by default "No". */
  answer: (_n: number): string | { status: number } => "No",
  /** Cameras VST has no recording of. */
  missing: new Set<string>(),
  /** The VLM is not running: its model list does not answer. */
  down: false,
};
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  ff.calls.length = 0;
  ff.frames = 930;
  Object.assign(vlm, { events: [], downloads: [], uploads: [], chats: [], active: 0, maxActive: 0, answer: () => "No", missing: new Set(), down: false });
  let files = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      await tick();
      if (url.pathname.includes("/storage/file/")) {
        vlm.downloads.push(url);
        const camera = decodeURIComponent(url.pathname.split("/").pop()!).replace("stream-", "");
        return vlm.missing.has(camera)
          ? new Response('{"error_code":"VMSNoDataError"}', { status: 404 })
          : new Response(new Uint8Array([1, 2, 3]));
      }
      if (url.pathname.endsWith("/v1/models")) {
        return vlm.down ? new Response("", { status: 503 }) : Response.json({ data: [{ id: "vlm-model-1" }] });
      }
      if (url.pathname.endsWith("/v1/files") && method === "POST") {
        vlm.active++;
        vlm.maxActive = Math.max(vlm.maxActive, vlm.active);
        vlm.uploads.push(init!.body as FormData);
        const id = `file-${files++}`;
        vlm.events.push(`upload ${id}`);
        return Response.json({ id });
      }
      if (url.pathname.endsWith("/v1/chat/completions")) {
        const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
        vlm.events.push(`ask ${String(body.id)}`);
        const answer = vlm.answer(vlm.chats.length);
        vlm.chats.push(body);
        return typeof answer === "string"
          ? Response.json({ choices: [{ message: { content: answer } }] })
          : new Response("model overloaded", { status: answer.status });
      }
      if (url.pathname.includes("/v1/files/") && method === "DELETE") {
        vlm.events.push(`delete ${url.pathname.split("/").pop()}`);
        vlm.active--;
        return Response.json({ deleted: true });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** The temp directory the last run worked in. */
const workDir = () => path.dirname(ff.calls[0].at(-1)!);
const inOrder = (n: number) => Array.from({ length: n }, (_, i) => [`upload file-${i}`, `ask file-${i}`, `delete file-${i}`]).flat();

describe("recordingHints", () => {
  it("asks about every chunk of every camera, one file at a time, and returns the answers that are not No", async () => {
    // The 2nd chunk of the scanner camera (question 11 of 20) shows the theft.
    vlm.answer = (n) => (n === 11 ? THEFT : n === 3 ? "No. Every item is moved over the scanner." : "No");
    const { hints, chunksAsked } = await recordingHints(SCENARIO, WINDOW);

    expect(hints).toEqual([
      { cameraId: "scanner-cam", start: "2026-11-18T17:42:57.000Z", end: "2026-11-18T17:43:07.000Z", text: THEFT },
    ]);
    expect(chunksAsked).toEqual({ "overhead-cam": 10, "scanner-cam": 10 });

    // Upload, question, delete: strictly one file after the other.
    expect(vlm.events).toEqual(inOrder(20));
    expect(vlm.maxActive).toBe(1);
    expect(vlm.uploads[0].get("purpose")).toBe("vision");
    expect(vlm.uploads[0].get("media_type")).toBe("video");
    expect(vlm.uploads[0].get("file")).toBeInstanceOf(Blob);
    expect(vlm.chats[0]).toEqual({
      model: "vlm-model-1",
      id: "file-0",
      chunk_duration: 0,
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: DEFAULT_QUESTION },
      ],
      media_io_kwargs: { video: { fps: 4 } },
      vlm_input_width: 854,
      vlm_input_height: 480,
      temperature: 0.01,
      max_tokens: 300,
    });
  });

  it("downloads the whole window per camera, past the 60 s cap of a clip", async () => {
    await recordingHints(SCENARIO, WINDOW);
    expect(vlm.downloads.map((u) => [decodeURIComponent(u.pathname.split("/").pop()!), u.searchParams.get("startTime"), u.searchParams.get("endTime")])).toEqual([
      ["stream-overhead-cam", WINDOW.start, WINDOW.end],
      ["stream-scanner-cam", WINDOW.start, WINDOW.end],
    ]);
    expect(vlm.downloads[0].searchParams.get("container")).toBe("mp4");
  });

  it("encodes every camera the same way, crops first, and cuts the chunks without re-encoding", async () => {
    await recordingHints(SCENARIO, WINDOW);
    const encodes = ff.calls.filter((a) => a.includes("libx264"));
    const cuts = ff.calls.filter((a) => a.includes("copy"));
    expect(encodes).toHaveLength(2);
    expect(cuts).toHaveLength(20);

    const vf = (a: string[]) => a[a.indexOf("-vf") + 1];
    expect(vf(encodes[0])).toBe("crop=1100:620:400:200,scale=854:480:out_range=tv,fps=15,format=yuv420p");
    expect(vf(encodes[1])).toBe("scale=854:480:out_range=tv,fps=15,format=yuv420p");
    const rest = (a: string[]) => a.slice(a.indexOf("-vf") + 2, -1).join(" ");
    expect(rest(encodes[0])).toBe(
      "-c:v libx264 -preset veryfast -profile:v main -level 3.1 -bf 0 -x264-params keyint=15:min-keyint=15:scenecut=0:range=tv -an -movflags +faststart",
    );
    expect(rest(encodes[1])).toBe(rest(encodes[0]));

    // The 2nd and the last chunk of the first camera: 6 s on, and flush with the end.
    const small = encodes[0].at(-1)!;
    expect(cuts[1].slice(0, -1)).toEqual(["-y", "-ss", "6", "-i", small, "-t", "10", "-c", "copy", "-avoid_negative_ts", "make_zero"]);
    expect(cuts[9].slice(1, 7)).toEqual(["-ss", "52", "-i", small, "-t", "10"]);
  });

  it("uses the scenario's chunking, frame rate, question and system prompt", async () => {
    await recordingHints(
      { ...SCENARIO, cameras: [{ id: "scanner-cam" }], chunkS: 20, overlapS: 0, framesPerSecond: 3, question: "Question: is a product carried away?", systemPrompt: "Watch the scanner." },
      WINDOW,
    );
    // 62 s in 20 s chunks without overlap: 0, 20, 40 and the last one flush at 42.
    expect(ff.calls.filter((a) => a.includes("copy")).map((a) => a[2])).toEqual(["0", "20", "40", "42"]);
    expect(vlm.chats[0]).toMatchObject({
      messages: [
        { role: "system", content: "Watch the scanner." },
        { role: "user", content: "Question: is a product carried away?" },
      ],
      media_io_kwargs: { video: { fps: 3 } },
    });
  });

  it("keeps one file at the VLM at a time across evaluations that run at once", async () => {
    const one = { ...SCENARIO, cameras: [{ id: "scanner-cam" }] };
    await Promise.all([recordingHints(one, WINDOW), recordingHints(one, WINDOW), recordingHints(one, WINDOW)]);
    expect(vlm.maxActive).toBe(1);
    expect(vlm.events).toEqual(inOrder(30));
  });

  it("removes its temp directory, also after a failure", async () => {
    await recordingHints(SCENARIO, WINDOW);
    expect(fs.existsSync(workDir())).toBe(false);

    ff.calls.length = 0;
    vlm.answer = () => ({ status: 500 });
    await expect(recordingHints(SCENARIO, WINDOW)).rejects.toThrow();
    expect(fs.existsSync(workDir())).toBe(false);
  });

  it("asks nothing while one camera's recording is missing", async () => {
    vlm.missing.add("scanner-cam");
    const run = recordingHints(SCENARIO, WINDOW);
    await expect(run).rejects.toBeInstanceOf(RecordingUnavailableError);
    await expect(run).rejects.toThrow(/no recording of camera scanner-cam/);
    expect(vlm.events).toEqual([]);
  });

  it("refuses a recording that does not cover the window", async () => {
    ff.frames = 43 * 15; // VST had finalized 43 of the 62 s
    const run = recordingHints(SCENARIO, WINDOW);
    await expect(run).rejects.toBeInstanceOf(RecordingUnavailableError);
    await expect(run).rejects.toThrow(/overhead-cam covers 43 of 62 s/);
    expect(vlm.events).toEqual([]);
    // Two seconds short is VST cutting at its own keyframes.
    ff.frames = 60 * 15;
    await expect(recordingHints(SCENARIO, WINDOW)).resolves.toMatchObject({ hints: [] });
  });

  it("gives up on the first chunk the VLM fails on, and still deletes that file", async () => {
    vlm.answer = (n) => (n === 2 ? { status: 500 } : "No");
    await expect(recordingHints(SCENARIO, WINDOW)).rejects.toThrow(/HTTP 500: model overloaded/);
    expect(vlm.events).toEqual(inOrder(3));
    expect(vlm.active).toBe(0);
  });

  it("treats an empty answer as a failure, not as a hint", async () => {
    vlm.answer = () => "  ";
    await expect(recordingHints(SCENARIO, WINDOW)).rejects.toThrow(/no answer for chunk 0 of camera overhead-cam/);
  });

  it("starts nothing on settings it cannot use, a scenario without cameras or a camera VST does not know", async () => {
    await expect(recordingHints({ ...SCENARIO, chunkS: 16 }, WINDOW)).rejects.toThrow(/64 frames per request/);
    await expect(recordingHints({ ...SCENARIO, cameras: [] }, WINDOW)).rejects.toThrow(/no cameras/);
    await expect(recordingHints({ ...SCENARIO, cameras: [{ id: "unknown-cam" }] }, WINDOW)).rejects.toThrow(/no VST stream found for camera unknown-cam/);
    await expect(recordingHints(SCENARIO, { start: WINDOW.end, end: WINDOW.start })).rejects.toThrow(/window is empty/);
    expect(vlm.downloads).toEqual([]);
    expect(ff.calls).toEqual([]);
  });

  it("downloads and re-encodes nothing while the VLM is not there to ask", async () => {
    vlm.down = true;
    await expect(recordingHints(SCENARIO, WINDOW)).rejects.toThrow(/the VLM does not list a model/);
    expect(vlm.downloads).toEqual([]);
    expect(ff.calls).toEqual([]);
  });
});
