// One request to an OpenAI-compatible /v1/chat/completions. Shared by the prompt
// preview, the incident report and the questions put to the VLM about a video
// file (vlm-files.ts), so the three read an answer and an error the same way.

/** The endpoint answered with a non-2xx status; `body` is its answer, unshortened. */
export class ChatCompletionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ChatCompletionHttpError";
  }
}

/**
 * POST `body` to `{baseUrl}/v1/chat/completions` and return the first choice's
 * text ("" when the answer carries none) and the model the endpoint names.
 * Throws ChatCompletionHttpError on a non-2xx answer, the fetch error otherwise.
 */
export async function chatCompletion(
  baseUrl: string,
  body: Record<string, unknown>,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ content: string; model?: string }> {
  const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!resp.ok) throw new ChatCompletionHttpError(resp.status, await resp.text().catch(() => ""));
  const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  return { content: json.choices?.[0]?.message?.content ?? "", ...(json.model ? { model: json.model } : {}) };
}
