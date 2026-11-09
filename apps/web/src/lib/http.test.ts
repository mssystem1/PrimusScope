import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DataAccessError } from "@primusscope/data";
import { ApiErrorSchema } from "@primusscope/api-schema";
import { errorResponse, HttpError, readJson, readQuery } from "./http";

describe("HTTP input and error boundary", () => {
  const querySchema = z.object({ limit: z.string().optional() }).strict();

  it("rejects repeated parameters, including decoded names", () => {
    expect(() => readQuery(new URL("https://example.test/?limit=1&%6cimit=2"), querySchema))
      .toThrow("Query parameters must not repeat.");
  });

  it.each(["unknown", "__proto__", "constructor", "toString"])("rejects unknown query key %s", key => {
    expect(() => readQuery(new URL(`https://example.test/?${key}=private-value`), querySchema))
      .toThrow(z.ZodError);
  });

  it("recognizes prototype-named duplicate keys before schema validation", () => {
    expect(() => readQuery(new URL("https://example.test/?__proto__=1&__proto__=2"), querySchema))
      .toThrow("Query parameters must not repeat.");
  });

  it("accepts JSON media types with parameters and case-insensitive names", async () => {
    const request = new Request("https://example.test/", {
      method: "POST", headers: { "Content-Type": "Application/JSON; charset=utf-8" }, body: '{"identifier":"public"}',
    });
    await expect(readJson(request)).resolves.toEqual({ identifier: "public" });
  });

  it("bounds actual UTF-8 bytes instead of trusting Content-Length", async () => {
    const request = new Request("https://example.test/", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: '"ééé"',
    });
    await expect(readJson(request, 7)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
  });

  it.each(["{", '"\u0000"'])("returns a bounded public error for malformed JSON", async body => {
    const request = new Request("https://example.test/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    await expect(readJson(request)).rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });
  });

  it("requires the supported content type", async () => {
    await expect(readJson(new Request("https://example.test/", { method: "POST", body: "private-value" })))
      .rejects.toMatchObject({ status: 415 });
  });

  it("redacts unexpected exceptions and schema issue details", async () => {
    const result = querySchema.safeParse({ privateCredential: "secret-value" });
    expect(result.success).toBe(false);
    for (const error of [new Error("secret-value"), !result.success && result.error]) {
      const response = errorResponse(error);
      const text = await response.text();
      expect(text).not.toContain("secret-value");
      expect(text).not.toContain("privateCredential");
      expect(ApiErrorSchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("preserves public data errors and identifies retryable failures", async () => {
    const absent = errorResponse(new DataAccessError("NOT_FOUND_IN_COVERAGE", "No recorded match.", 404));
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ code: "NOT_FOUND_IN_COVERAGE", retryable: false });
    const unavailable = errorResponse(new HttpError("SOURCE_UNAVAILABLE", "Recorded data is unavailable.", 503));
    expect(await unavailable.json()).toMatchObject({ code: "SOURCE_UNAVAILABLE", retryable: true });
  });
});
