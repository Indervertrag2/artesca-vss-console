import "server-only";
import { openAsBlob } from "fs";
import { CLUSTER } from "@/lib/cluster-refs";
import { createLogger } from "@/lib/logger";
import { chatCompletion } from "@/lib/helpers/chat-completions";

// A question put to the VLM about one video file: upload the file, one chat
// completion that names it, delete it again. Unlike the chunks of a live stream
// this writes nothing into the alert pipeline, so it raises no alert of its own.
//
// Measured on the VLM: two file requests at once, or files encoded differently
// from each other, left it hanging, and it has no timeout of its own. So the
// whole upload, question and delete of one file is one turn in a queue that is
// one per process, and every request carries a client timeout. Callers encode
// every file the same way (purchase-recording.ts).

const log = createLogger("vlm-files");

const TIMEOUT_MS = 120_000;
/** The picture size the model is given. */
export const VLM_INPUT = { width: 854, height: 480 } as const;

// On globalThis: the purchase runner and the routes need not share a module instance.
const g = globalThis as unknown as { __vlmFileQueue?: Promise<unknown> };

export interface VideoQuestion {
  /** The model id, from the VLM's /v1/models (`liveVlmModelId`). */
  model: string;
  system: string;
  question: string;
  framesPerSecond: number;
}

/** The model's answer about the MP4 at `file`. Waits its turn behind every other
 *  file request of this process. Throws when the VLM refuses or does not answer. */
export function askVlmAboutVideo(file: string, ask: VideoQuestion): Promise<string> {
  const turn = (g.__vlmFileQueue ?? Promise.resolve()).then(() => uploadAskDelete(file, ask));
  g.__vlmFileQueue = turn.catch(() => undefined);
  return turn;
}

async function uploadAskDelete(file: string, ask: VideoQuestion): Promise<string> {
  // The VLM's base URL is where cluster-refs lists its models.
  const base = CLUSTER.alertBridge.vlmModelsUrl.replace(/\/v1\/models\/?$/, "");
  const form = new FormData();
  form.append("file", await openAsBlob(file, { type: "video/mp4" }), "chunk.mp4");
  form.append("purpose", "vision");
  form.append("media_type", "video");
  const up = await fetch(`${base}/v1/files`, { method: "POST", body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!up.ok) {
    throw new Error(`VLM file upload returned HTTP ${up.status}: ${(await up.text().catch(() => "")).slice(0, 300)}`);
  }
  const id = ((await up.json()) as { id?: unknown }).id;
  if (typeof id !== "string" || !id) throw new Error("VLM file upload returned no file id");
  try {
    const { content } = await chatCompletion(
      base,
      {
        model: ask.model,
        id,
        chunk_duration: 0,
        messages: [
          { role: "system", content: ask.system },
          { role: "user", content: ask.question },
        ],
        media_io_kwargs: { video: { fps: ask.framesPerSecond } },
        vlm_input_width: VLM_INPUT.width,
        vlm_input_height: VLM_INPUT.height,
        temperature: 0.01,
        max_tokens: 300,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    return content.trim();
  } finally {
    // Also after a failed question: a file left behind stays on the VLM.
    await fetch(`${base}/v1/files/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then((r) => (r.ok ? undefined : log.warn(`VLM file ${id} not deleted: HTTP ${r.status}`)))
      .catch((err) => log.warn(`VLM file ${id} not deleted`, { err: String(err) }));
  }
}
