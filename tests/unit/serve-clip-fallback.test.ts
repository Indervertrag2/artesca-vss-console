// The recent-window fallback of serveClipPlaylist (camera-clock skew): only a
// fresh incident gets it, and the substitute clip is never cached under the
// incident's key.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";

// In-memory clip cache: cache dir names carry ISO colons, which Windows paths reject.
const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return {
    ...real,
    statSync: ((p: string) =>
      files.has(String(p)) ? { mtimeMs: Date.now() } : real.statSync(p)) as typeof real.statSync,
    readFileSync: ((p: string, enc?: BufferEncoding) =>
      files.get(String(p)) ?? real.readFileSync(p, enc)) as typeof real.readFileSync,
    existsSync: ((p: string) => files.has(String(p)) || real.existsSync(p)) as typeof real.existsSync,
  };
});
vi.mock("@/lib/streams/clip-cache", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/streams/clip-cache")>();
  return { ...real, ensureCacheDir: real.cacheDir, evictLru: () => {} };
});
vi.mock("@/lib/streams/ffmpeg", () => ({
  transcodeToHls: vi.fn(async (_in: string, outDir: string) => {
    files.set(path.join(outDir, "index.m3u8"), "#EXTM3U\n#EXTINF:2.0,\nseg000.ts\n#EXT-X-ENDLIST\n");
  }),
  extractThumbnail: vi.fn(async () => {}),
}));
vi.mock("@/lib/s3", () => ({
  makeS3Client: () => ({ send: async () => { throw new Error("NoSuchKey"); } }),
  s3BucketForAlertClips: () => "alert-clips",
  s3KeyForAlertClip: () => "manifest.json",
}));
vi.mock("@/lib/streams/vst-clip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/streams/vst-clip")>()),
  resolveStreamId: async () => "stream-1",
}));

import { serveClipPlaylist } from "@/lib/streams/serve-clip";
import { cachePath } from "@/lib/streams/clip-cache";

const NOW = Date.parse("2026-01-03T12:00:00.000Z");
const RECENT_TS = new Date(NOW - 30_000).toISOString();

beforeEach(() => {
  files.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  // VST has the recent window only: the incident's own window 404s.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const start = new URL(url).searchParams.get("startTime");
      return start === new Date(NOW - 35_000).toISOString()
        ? new Response(new Uint8Array([1, 2, 3]))
        : new Response('{"error":"VMSNoDataError"}', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("serveClipPlaylist recent-window fallback", () => {
  it("answers 404 for an old incident whose window VST does not have", async () => {
    const ts = "2026-01-01T12:00:00.000Z"; // two days old

    const res = await serveClipPlaylist("cam-a", ts);

    expect(res.status).toBe(404);
    expect(files.has(cachePath("cam-a", ts, "index.m3u8"))).toBe(false);
  });

  it("serves a fresh incident the recent window, marked, and not under its own key", async () => {
    const ts = new Date(NOW - 60_000).toISOString();

    const res = await serveClipPlaylist("cam-a", ts);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Source")).toBe("vst-recent");
    expect(files.has(cachePath("cam-a", ts, "index.m3u8"))).toBe(false);
    // The segments are the recent window's own cache entry.
    expect(await res.text()).toContain(`../${encodeURIComponent(RECENT_TS)}/seg000.ts`);
    expect(files.has(cachePath("cam-a", RECENT_TS, "index.m3u8"))).toBe(true);
  });
});
