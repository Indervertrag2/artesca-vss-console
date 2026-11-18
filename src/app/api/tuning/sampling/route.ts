// GET/PATCH /api/tuning/sampling
//
// VLM frame sampling for the realtime-alert path. These knobs live on the
// alert-bridge rules (per-query), sourced from the `realtime-alert-rules`
// ConfigMap that the vlm-stream-reconciler converges from — NOT a NIM env.
//
// GET  reads the desired sampling from the ConfigMap's rules.json top-level.
// PATCH writes the new sampling into rules.json, then deletes the live rules so
//       the reconciler re-seeds them from the updated ConfigMap (~15s). Single
//       writer (the reconciler), so no duplicate rules. Without a reconciler
//       deployed, the route re-POSTs each rule it deleted itself.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { CLUSTER } from "@/lib/cluster-refs";
import { readConfigMapKey, patchConfigMapRawKey } from "@/lib/helpers/configmaps";
import { deleteRealtimeRule } from "@/lib/helpers/alert-bridge";
import { auditLog } from "@/lib/helpers/audit";
import { deploymentExists } from "@/lib/k8s";
import { withRequestContext } from "@/lib/with-request-context";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { extractK8sError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const RULES_KEY = "rules.json";

const DEFAULTS = {
  framesPerChunk: 6,
  useFps: false,
  chunkDuration: 30,
} as const;

const SamplingSchema = z.object({
  // alert-bridge types this as an integer; fps mode treats it as frames/sec,
  // fixed mode as frames-per-chunk.
  framesPerChunk: z.number().int().min(1).max(30),
  useFps: z.boolean(),
  chunkDuration: z.number().int().min(5).max(120),
});

interface RulesDoc {
  num_frames_per_second_or_fixed_frames_chunk?: number;
  use_fps_for_chunking?: boolean;
  chunk_duration?: number;
  [k: string]: unknown;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { value } = await readConfigMapKey<RulesDoc>(
      CLUSTER.alertBridge.rulesNamespace,
      CLUSTER.alertBridge.rulesConfigMap,
      RULES_KEY,
    );
    return NextResponse.json({
      framesPerChunk:
        typeof value?.num_frames_per_second_or_fixed_frames_chunk === "number"
          ? value.num_frames_per_second_or_fixed_frames_chunk
          : DEFAULTS.framesPerChunk,
      useFps:
        typeof value?.use_fps_for_chunking === "boolean"
          ? value.use_fps_for_chunking
          : DEFAULTS.useFps,
      chunkDuration:
        typeof value?.chunk_duration === "number"
          ? value.chunk_duration
          : DEFAULTS.chunkDuration,
    });
  } catch (err: unknown) {
    const { status } = extractK8sError(err);
    // ConfigMap absent → report defaults rather than erroring the page.
    if (status === 404) return NextResponse.json({ ...DEFAULTS, warning: "rules ConfigMap not found — showing defaults" });
    const { message } = extractK8sError(err);
    return NextResponse.json({ error: message }, { status });
  }
}

export const PATCH = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;

  const body = await req.json().catch(() => null);
  const parsed = SamplingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }
  const { framesPerChunk, useFps, chunkDuration } = parsed.data;

  const ns = CLUSTER.alertBridge.rulesNamespace;
  const cm = CLUSTER.alertBridge.rulesConfigMap;

  // ── Step 1: patch rules.json top-level sampling in the ConfigMap ───────────
  let doc: RulesDoc;
  let resourceVersion: string | undefined;
  try {
    const read = await readConfigMapKey<RulesDoc>(ns, cm, RULES_KEY);
    doc = read.value && typeof read.value === "object" ? read.value : ({} as RulesDoc);
    resourceVersion = read.resourceVersion;
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json({ error: `read rules ConfigMap failed: ${message}`, k8sCode: status }, { status });
  }

  doc.num_frames_per_second_or_fixed_frames_chunk = framesPerChunk;
  doc.use_fps_for_chunking = useFps;
  doc.chunk_duration = chunkDuration;

  try {
    await patchConfigMapRawKey(ns, cm, RULES_KEY, JSON.stringify(doc, null, 2), resourceVersion);
  } catch (err: unknown) {
    const { status, message } = extractK8sError(err);
    return NextResponse.json({ error: `patch rules ConfigMap failed: ${message}`, k8sCode: status }, { status });
  }

  // ── Step 2: re-register each live rule with the new sampling ───────────────
  // The alert-bridge has no PATCH on a rule, so applying a sampling change means
  // delete + re-POST. Where the reconciler is deployed it re-seeds the deleted
  // rules from the ConfigMap and the route must not POST: two writers each see
  // no rule for a sensor and each post one (see restoreCameras in
  // test-footage-run.ts). Otherwise we re-register from the LIVE rules (which
  // carry the stream URL + full config), each POST after its own delete, so a
  // rule is only briefly absent and the set is never emptied.
  const warnings: string[] = [];
  const reconciler = await deploymentExists(ns, CLUSTER.alertBridge.reconcilerDeployment);
  let live: Array<Record<string, unknown>> = [];
  try {
    const resp = await fetch(CLUSTER.alertBridge.realtimeUrl, {
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) {
      const json = (await resp.json()) as { rules?: Array<Record<string, unknown>> };
      live = json.rules ?? [];
    } else {
      warnings.push(`alert-bridge GET returned HTTP ${resp.status}`);
    }
  } catch (err) {
    warnings.push(`alert-bridge unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Preserve everything on the rule; override only the sampling knobs.
  const PRESERVE = [
    "live_stream_url", "sensor_id", "sensor_name", "alert_type", "prompt",
    "system_prompt", "model", "chunk_overlap_duration", "enable_reasoning",
    "vlm_input_width", "vlm_input_height",
  ] as const;

  // Re-register all rules concurrently — each rule's delete→POST is sequential
  // (the POST must follow its own DELETE), but the rules run in parallel so the
  // whole save is ~one round-trip instead of N, which kept the Save button from
  // client-timing-out on a slow alert-bridge. Rules are independent (per sensor).
  const outcomes = await Promise.all(
    live.map(async (r): Promise<{ ok: boolean; warning?: string }> => {
      if (!reconciler && (!r.live_stream_url || !r.alert_type)) return { ok: false };
      const id = typeof r.id === "string" ? r.id : undefined;
      const body: Record<string, unknown> = {};
      for (const k of PRESERVE) if (r[k] !== undefined && r[k] !== null) body[k] = r[k];
      body.chunk_duration = chunkDuration;
      body.num_frames_per_second_or_fixed_frames_chunk = framesPerChunk;
      body.use_fps_for_chunking = useFps;

      // A POST after a failed delete leaves the camera with two rules.
      if (id) {
        const del = await deleteRealtimeRule(id);
        if (!del.ok) return { ok: false, warning: `delete ${String(r.sensor_name)} rule: ${del.warning ?? "failed"}` };
      }
      if (reconciler) return { ok: true };
      try {
        const post = await fetch(CLUSTER.alertBridge.realtimeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (post.ok || post.status === 409) return { ok: true };
        return { ok: false, warning: `re-register ${String(r.sensor_name)} → HTTP ${post.status}` };
      } catch (err) {
        return { ok: false, warning: `re-register ${String(r.sensor_name)} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    })
  );

  let reRegistered = 0;
  for (const o of outcomes) {
    if (o.ok) reRegistered += 1;
    else if (o.warning) warnings.push(o.warning);
  }

  await auditLog("tuning-sampling", `configmap/${cm}`, {
    patches: {
      num_frames_per_second_or_fixed_frames_chunk: String(framesPerChunk),
      use_fps_for_chunking: String(useFps),
      chunk_duration: String(chunkDuration),
    },
    rulesReRegistered: String(reRegistered),
  });

  return NextResponse.json({
    ok: true,
    applied: { framesPerChunk, useFps, chunkDuration },
    rulesReRegistered: reRegistered,
    note: reconciler
      ? "Sampling persisted to the rules ConfigMap; the live rules were deleted and the reconciler re-seeds them. No VLM restart."
      : "Sampling persisted to the rules ConfigMap and applied by re-registering each live rule. No VLM restart.",
    ...(warnings.length ? { warnings } : {}),
  });
});
