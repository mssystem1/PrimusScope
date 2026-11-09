import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ApiErrorSchema } from "@primusscope/api-schema";
import { getObservationSet } from "@primusscope/data";
import { GET, POST } from "./route";

function get(path: string, query = "") {
  return GET(new NextRequest(`https://example.test/api/v1/${path}${query}`), {
    params: Promise.resolve({ segments: path.split("/") }),
  });
}

describe("public observations API routes", () => {
  it("serves a serializable OpenAPI 3.1 document with strict public schemas", async () => {
    const response = await get("openapi.json");
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: "/api/v1" }]);
    expect(document.paths["/explore/lookup"].post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    expect(document.components.schemas.Coverage.properties.finality.const).toBe("provider_reported_finalized");
    expect(document.components.schemas.FinanceEvent.additionalProperties).toBe(false);
    expect(document.components.schemas.NetworkEvent.additionalProperties).toBe(false);
  });

  it.each(["?privateCredential=secret-value", "?__proto__=secret-value", "?foo=1&foo=2"])(
    "rejects unsupported or duplicate query fields %s without echoing input", async query => {
      const response = await get("overview", query);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain("secret-value");
      expect(text).not.toContain("privateCredential");
      expect(ApiErrorSchema.parse(JSON.parse(text)).code).toBe("INVALID_QUERY");
    },
  );

  it.each(["__proto__", "constructor", "toString", "unknown"])("rejects inherited or unknown metric key %s", async key => {
    const response = await get(`metrics/${key}/definition`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns a supported metric definition", async () => {
    const response = await get("metrics/network.task_requests/definition");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ key: "network.task_requests", unit: "tasks", definitionVersion: "1.0.0" });
  });

  it.each(["1e2", "0x10", "+1", "01", "0", "101"])("rejects noncanonical or out-of-range page limit %s", async limit => {
    const response = await get("finance/vaults/recorded-route/batches", `?limit=${encodeURIComponent(limit)}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_QUERY" });
  });

  it("accepts a canonical network chain ID and rejects implicit numeric coercions", async () => {
    expect((await get("network/summary", "?chainId=8453")).status).toBe(200);
    for (const chainId of ["8.453e3", "0x2105", "08453", "9007199254740992"]) {
      const response = await get("network/summary", `?chainId=${chainId}`);
      expect(response.status).toBe(400);
    }
    expect((await get("network/summary", "?chainId=56")).status).toBe(422);
  });

  it("rejects private lookup fields without returning their keys or values", async () => {
    const response = await POST(new NextRequest("https://example.test/api/v1/explore/lookup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "0x" + "a".repeat(64), privateCredential: "secret-value" }),
    }), { params: Promise.resolve({ segments: ["explore", "lookup"] }) });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("privateCredential");
    expect(text).not.toContain("secret-value");
    expect(ApiErrorSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });

  it("returns source-labelled, filtered CSV with download-safe headers", async () => {
    const routeId = getObservationSet().finance.contracts[0].routeId;
    const response = await get("exports/metrics.csv", `?domain=finance&routeId=${encodeURIComponent(routeId)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("primusscope-finance-observations.csv");
    const text = await response.text();
    expect(text.split("\n")[0]).toContain("snapshot_id");
    expect(text.split("\n")[0]).toContain("source_id");
  });
});
