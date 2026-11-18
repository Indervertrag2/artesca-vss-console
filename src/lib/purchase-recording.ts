import "server-only";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { createLogger } from "@/lib/logger";
import { liveVlmModelId } from "@/lib/helpers/ingestion";
import { askVlmAboutVideo, VLM_INPUT } from "@/lib/helpers/vlm-files";
import { spawnFfmpeg } from "@/lib/streams/ffmpeg";
import { resolveStreamId, vstFileUrl } from "@/lib/streams/vst-clip";
import {
  evidenceError,
  isNegative,
  planChunks,
  recordingSettings,
  type Hint,
  type ScenarioCamera,
  type ScenarioMulti,
} from "@/lib/purchase-judge";

// Hints from the recording of a purchase, the second way a multi-camera scenario
// gets them (`evidence: "recording"`). The live stream is cut into fixed chunks
// whose borders fall anywhere, and an act split over two of them was reported by
// neither. Here each camera's recording of the purchase window is cut into
// overlapping chunks that start with the window, and every chunk is put to the
// VLM as a file (helpers/vlm-files.ts) with the scenario's question.

const log = createLogger("purchase-recording");

/** Frame rate of every chunk, with a keyframe each second: a cut at a whole second needs no re-encode. */
const FPS = 15;
/** How much shorter than the window a recording may be; VST cuts at its own keyframes. */
const SLACK_S = Number(process.env.PURCHASE_RECORDING_SLACK_S) || 2;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** VST has no recording of a camera for the window, or one that does not cover it:
 *  not finalized yet (about 50 s after its end) or no longer kept. */
export class RecordingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingUnavailableError";
  }
}

export interface RecordingEvidence {
  hints: Hint[];
  /** Chunks put to the model, per camera. */
  chunksAsked: Record<string, number>;
}

type Chunk = { startS: number; endS: number };

async function ffmpeg(args: string[], what: string): Promise<string> {
  const { code, stderr } = await spawnFfmpeg(args);
  if (code !== 0) throw new Error(`ffmpeg: ${what} failed (${code}): ${stderr.slice(-300)}`);
  return stderr;
}

/**
 * One camera's recording from `start` for `durationS` seconds, as one MP4 per
 * chunk in `dir`. The download is re-encoded once and the chunks are cut from
 * that without re-encoding. Every chunk of every camera is encoded the same way:
 * files that differed left the VLM hanging.
 */
async function cutRecording(
  cam: ScenarioCamera,
  n: number,
  start: number,
  durationS: number,
  chunks: Chunk[],
  dir: string,
): Promise<string[]> {
  const streamId = await resolveStreamId(cam.id);
  if (!streamId) throw new Error(`no VST stream found for camera ${cam.id}`);
  const resp = await fetch(vstFileUrl(streamId, new Date(start), new Date(start + durationS * 1000)), {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok || !resp.body) {
    const body = (await resp.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ").trim();
    if (resp.status === 404 || body.includes("VMSNoDataError")) {
      throw new RecordingUnavailableError(`VST has no recording of camera ${cam.id} for the purchase window`);
    }
    throw new Error(`VST returned HTTP ${resp.status} for the recording of camera ${cam.id}${body ? `: ${body}` : ""}`);
  }
  const raw = path.join(dir, `${n}-raw.mp4`);
  await fs.promises.writeFile(raw, Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]));

  const small = path.join(dir, `${n}.mp4`);
  const filter = [
    ...(cam.crop ? [`crop=${cam.crop.width}:${cam.crop.height}:${cam.crop.x}:${cam.crop.y}`] : []),
    `scale=${VLM_INPUT.width}:${VLM_INPUT.height}:out_range=tv`,
    `fps=${FPS}`,
    "format=yuv420p",
  ].join(",");
  const stderr = await ffmpeg(
    [
      "-y", "-i", raw,
      "-vf", filter,
      "-c:v", "libx264", "-profile:v", "main", "-level", "3.1", "-bf", "0",
      "-x264-params", `keyint=${FPS}:min-keyint=${FPS}:scenecut=0:range=tv`,
      "-an", "-movflags", "+faststart",
      small,
    ],
    `re-encoding the recording of camera ${cam.id}`,
  );
  // ffmpeg's last progress line counts the frames written; at a fixed rate that is the length.
  const frames = Number([...stderr.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1]);
  if (!Number.isFinite(frames)) throw new Error(`ffmpeg reported no length for the recording of camera ${cam.id}`);
  if (frames / FPS < durationS - SLACK_S) {
    throw new RecordingUnavailableError(
      `the recording of camera ${cam.id} covers ${Math.floor(frames / FPS)} of ${durationS} s`,
    );
  }

  const files: string[] = [];
  for (const [k, c] of chunks.entries()) {
    const file = path.join(dir, `${n}-${k}.mp4`);
    await ffmpeg(
      ["-y", "-ss", String(c.startS), "-i", small, "-t", String(c.endS - c.startS), "-c", "copy", "-avoid_negative_ts", "make_zero", file],
      `cutting chunk ${k} of camera ${cam.id}`,
    );
    files.push(file);
  }
  return files;
}

/**
 * The hints of one purchase window from the recordings of the scenario's cameras:
 * every answer that is not a "No", with its chunk's span. Throws when a camera's
 * recording is missing or short (RecordingUnavailableError) or the VLM fails, so
 * a purchase is never judged on part of its evidence. Works in a temp directory
 * of its own and removes it.
 */
export async function recordingHints(s: ScenarioMulti, window: { start: string; end: string }): Promise<RecordingEvidence> {
  const problem = evidenceError(s);
  if (problem) throw new Error(problem);
  const cameras = s.cameras ?? [];
  if (!cameras.length) throw new Error("no cameras configured");
  const cfg = recordingSettings(s);
  const start = Date.parse(window.start);
  // Whole seconds, so that every chunk starts on a keyframe.
  const durationS = Math.ceil((Date.parse(window.end) - start) / 1000);
  if (!(durationS > 0)) throw new Error("the purchase window is empty");
  const chunks = planChunks(durationS, cfg.chunkS, cfg.overlapS);
  // Before any download: with the VLM down (the box in another GPU mode) nothing is re-encoded for nothing.
  const model = await liveVlmModelId();
  if (!model) throw new Error("the VLM does not list a model");
  const began = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purchase-"));
  try {
    // Every camera's recording first: nothing is asked while one of them is missing.
    const files: string[][] = [];
    for (const [n, cam] of cameras.entries()) files.push(await cutRecording(cam, n, start, durationS, chunks, dir));

    const hints: Hint[] = [];
    for (const [n, cam] of cameras.entries()) {
      for (const [k, c] of chunks.entries()) {
        const text = await askVlmAboutVideo(files[n][k], {
          model,
          system: cfg.systemPrompt,
          question: cfg.question,
          framesPerSecond: cfg.framesPerSecond,
        });
        if (!text) throw new Error(`the VLM gave no answer for chunk ${k} of camera ${cam.id}`);
        if (!isNegative(text)) {
          hints.push({
            cameraId: cam.id,
            start: new Date(start + c.startS * 1000).toISOString(),
            end: new Date(start + c.endS * 1000).toISOString(),
            text,
          });
        }
      }
    }
    log.info(
      `${cameras.length} camera(s) x ${chunks.length} chunk(s) of ${durationS} s asked in ${Math.round((Date.now() - began) / 1000)} s: ${hints.length} hint(s)`,
    );
    return { hints, chunksAsked: Object.fromEntries(cameras.map((c) => [c.id, chunks.length])) };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      log.warn(`temp directory ${dir} not removed`, { err: String(err) });
    }
  }
}
