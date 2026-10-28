import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { rejectIfKiosk } from "@/lib/kiosk-server";
import { auditLog } from "@/lib/helpers/audit";
import { createLogger } from "@/lib/logger";
import { FileConfigStore } from "@/lib/config-store/file";
import { FillError, parseFillSource } from "@/lib/config-store/fill";

export const dynamic = "force-dynamic";

const log = createLogger("api/config-store/restore");

/** A showroom's export is a few KB; this bounds what a caller can make the pod parse. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * POST /api/config-store/restore — fill each EMPTY list of this instance's store
 * (cameras, scenarios, prompt sets) from a copy `GET /api/config-store/export`
 * gave, and nothing else. A list that holds anything is kept as it is, whatever
 * the copy says; the check and the write are one hold of the file's lock
 * (`FileConfigStore.fillEmpty`). Answers `{ restored, kept, activePromptId }`.
 *
 * The AI Factory's GPU switch calls it on entering `vss` mode with the copy it
 * saved on leaving (README "Sharing the box with the AI Factory"). The reconcile
 * loop then converges the cluster onto the restored lists, as after any edit.
 *
 * File store only: Firestore has no lock this check could share with its write.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await rejectIfKiosk();
  if (blocked) return blocked;
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: `body over ${MAX_BODY_BYTES} bytes` }, { status: 413 });

  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  let ctx;
  try {
    ctx = await makeReconcileContext();
  } catch (err) {
    return NextResponse.json({ error: `config store unavailable: ${err instanceof Error ? err.message : String(err)}` }, { status: 503 });
  }
  if (!(ctx.store instanceof FileConfigStore)) {
    return NextResponse.json({ error: "restore needs the file config store (CONSOLE_CONFIG_STORE=file)" }, { status: 501 });
  }

  let src;
  try {
    src = parseFillSource(JSON.parse(text), ctx.instance);
  } catch (err) {
    const msg = err instanceof FillError ? err.message : "body: not JSON";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const actor = session.user?.name ?? session.user?.email ?? "unknown";
  try {
    const result = await ctx.store.fillEmpty(ctx.instance, src, `config-store-restore:${actor}`);
    if (result.restored.length > 0) {
      await auditLog("config-store-restore", `file/${ctx.instance}`, {
        restored: result.restored,
        kept: result.kept,
        counts: Object.fromEntries(result.restored.map((k) => [k, src[k].length])),
      });
    }
    log.info("restore", { instance: ctx.instance, ...result });
    return NextResponse.json(result);
  } catch (err) {
    log.error("restore failed", { err });
    return NextResponse.json({ error: `restore failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}
