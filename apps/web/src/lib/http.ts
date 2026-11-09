import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiErrorCodeSchema, ApiErrorSchema } from "@primusscope/api-schema";
import { DataAccessError, getServingMode } from "@primusscope/data";

export class HttpError extends Error {
  constructor(public code: z.infer<typeof ApiErrorCodeSchema>, message: string, public status = 400) {
    super(message);
  }
}

export function readQuery<T extends z.ZodType>(url: URL, schema: T): z.infer<T> {
  // URL parameter names are untrusted, including Object.prototype keys.
  const params: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(params, key)) throw new HttpError("INVALID_QUERY", "Query parameters must not repeat.");
    params[key] = value;
  }
  return schema.parse(params);
}

export async function readJson(request: Request, maximumBytes = 2048): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError("INVALID_QUERY", "Use an application/json request body.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError("INVALID_QUERY", "Provide a JSON request body.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new HttpError("PAYLOAD_TOO_LARGE", "The lookup body exceeds the supported size.", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("INVALID_QUERY", "Provide a valid JSON lookup body.");
  } finally {
    reader.releaseLock();
  }
}

export function jsonResponse(body: unknown, status = 200): NextResponse {
  let mode: string;
  if (body && typeof body === "object" && "mode" in body && typeof body.mode === "string") mode = body.mode;
  else {
    try { mode = getServingMode(); } catch { mode = "unavailable"; }
  }
  return NextResponse.json(body, { status, headers: {
    "Cache-Control": "no-store",
    "X-PrimusScope-Data-Mode": mode.replaceAll("_", "-"),
  }});
}

export function errorResponse(error: unknown): NextResponse {
  let code: z.infer<typeof ApiErrorCodeSchema> = "INTERNAL_ERROR";
  let message = "The request could not be completed.";
  let status = 500;
  if (error instanceof z.ZodError) {
    code = "INVALID_QUERY"; message = "Check the supported request fields and formats."; status = 400;
  } else if (error instanceof HttpError || error instanceof DataAccessError) {
    const parsed = ApiErrorCodeSchema.safeParse(error.code);
    if (parsed.success) {
      code = parsed.data; message = error.message; status = error.status;
    }
  }
  return jsonResponse(ApiErrorSchema.parse({ code, message, requestId: randomUUID(),
    retryable: status >= 500 || status === 429 }), status);
}
