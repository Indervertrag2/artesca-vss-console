import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { CONFIG_SCHEMA } from "@/lib/config-store/file";

export const dynamic = "force-dynamic";

/**
 * GET /api/config-store/export — this instance's cameras, scenarios and prompt
 * sets as the store holds them, the body `POST /api/config-store/restore` takes.
 *
 * The AI Factory's GPU switch saves it when the box leaves `vss` mode (its
 * snapshot store, never committed: RTSP URLs can carry credentials) and restores
 * it into empty lists on the way back (README "Sharing the box with the AI Factory").
 *
 * A store that cannot be read answers 503, never empty lists: a caller must not
 * be able to mistake an unreadable store for an emptied one.
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { makeReconcileContext } = await import("@/lib/reconcile/context");
  try {
    const ctx = await makeReconcileContext();
    const [cameras, scenarios, promptSets, activePromptId] = await Promise.all([
      ctx.store.readCameras(ctx.instance),
      ctx.store.readScenarios(ctx.instance),
      ctx.store.readPromptSets(ctx.instance),
      ctx.store.readActivePromptId(ctx.instance),
    ]);
    return NextResponse.json({ schema: CONFIG_SCHEMA, instance: ctx.instance, cameras, scenarios, promptSets, activePromptId });
  } catch (err) {
    return NextResponse.json(
      { error: `config store unavailable: ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 },
    );
  }
}
