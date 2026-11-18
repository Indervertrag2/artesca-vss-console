import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { z } from "zod";
import { withRequestContext } from "@/lib/with-request-context";
import { CLUSTER } from "@/lib/cluster-refs";
import { chatCompletion, ChatCompletionHttpError } from "@/lib/helpers/chat-completions";

export const dynamic = "force-dynamic";

const PreviewSchema = z.object({
  prompt: z.string().min(1),
  userMessage: z.string().min(1),
});

export const POST = withRequestContext(async function (req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PreviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 400 });
  }

  const { prompt, userMessage } = parsed.data;

  const previewModel =
    process.env.NIM_PREVIEW_MODEL ?? "nvila-lite-2b";

  const payload = {
    model: previewModel,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userMessage },
    ],
    max_tokens: 512,
    temperature: 0.1,
  };

  const startMs = Date.now();

  try {
    const { content, model } = await chatCompletion(
      process.env.NIM_PREVIEW_ENDPOINT ?? CLUSTER.nim.previewEndpoint,
      payload,
    );
    return NextResponse.json({ response: content, latencyMs: Date.now() - startMs, model: model ?? previewModel });
  } catch (err) {
    if (err instanceof ChatCompletionHttpError) {
      return NextResponse.json(
        { error: `Preview NIM returned HTTP ${err.status}: ${err.body}` },
        { status: 502 }
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Preview NIM unreachable: ${msg}` },
      { status: 503 }
    );
  }
});
