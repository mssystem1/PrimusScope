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
  it('returns source-bound period comparisons without manufacturing growth from missing history',async()=>{
    const finance=await(await get('finance/analytics','?range=custom&from=2026-10-01&to=2026-10-07')).json();
    expect(finance.comparison.strategyFlows.status).toBe('available');expect(finance.comparison.routeOperations.status).toBe('unavailable');
    expect(finance.comparison.strategyFlows.previous).toMatchObject({from:'2026-09-24T00:00:00.000Z',to:'2026-09-30T23:59:59.999Z',complete:true});
    const network=await(await get('network/analytics','?range=7d')).json();expect(network.comparison.reason).toBe('INCOMPLETE_COVERAGE');expect(network.comparison.metrics.every((m:{delta:null})=>m.delta===null)).toBe(true);
  });
  it('checks public saved objects without storing the watchlist or exposing raw event payloads',async()=>{
    const snapshot=await getObservationSet(),task=snapshot.network.stateSamples[0]!.taskId;
    const response=await POST(new NextRequest('https://example.test/api/v1/workspace/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{id:'task',href:`/network/tasks/8453/${snapshot.network.taskContract}/${task}`}]})}),{params:Promise.resolve({segments:['workspace','check']})});
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');const result=await response.json();expect(result.snapshotId).toBe(snapshot.snapshotId);expect(result.items[0]).toMatchObject({id:'task',availability:'available'});expect(result.items[0]).not.toHaveProperty('events');expect(result.items[0]).not.toHaveProperty('signatures');
  });
  it('rejects private fields and oversized saved-object check bodies before serving them',async()=>{
    const request=(body:unknown)=>POST(new NextRequest('https://example.test/api/v1/workspace/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({segments:['workspace','check']})});
    const privateField=await request({items:[],attestation:'PRIVATE_WORKSPACE_INPUT'});expect(privateField.status).toBe(400);expect(await privateField.text()).not.toContain('PRIVATE_WORKSPACE_INPUT');
    expect((await request({items:[],extra:'x'.repeat(50000)})).status).toBe(413);
  });
  it('supports exact inclusive UTC dates without substituting present-day KPIs',async()=>{
    const response=await get('finance/analytics','?range=custom&from=2026-10-01&to=2026-10-15&interval=day');
    expect(response.status).toBe(200);const body=await response.json();
    expect(body.strategy.points).toHaveLength(15);expect(body.strategy.sourceAsOf.slice(0,10)).toBe('2026-10-15');
    expect(body.strategy.requestedTo).toBe('2026-10-15T23:59:59.999Z');
    expect(body.operations.hasCoverage).toBe(false);expect(body.operations.series).toEqual([]);
    const future=await (await get('network/analytics','?range=custom&from=2030-01-01&to=2030-01-02')).json();
    expect(future.analytics).toMatchObject({hasCoverage:false,coveredFrom:null,coveredTo:null,series:[]});
  });
  it('rejects malformed, mismatched and duplicate calendar-date parameters',async()=>{
    for(const query of ['?range=custom&from=2026-02-30&to=2026-03-01','?range=custom&from=2026-11-09','?range=7d&from=2026-11-01&to=2026-11-09','?range=custom&from=2026-11-01&from=2026-11-02&to=2026-11-09']){
      expect((await get('finance/analytics',query)).status).toBe(400);
    }
  });

  it('serves actual strategy history separately from Primus route operations',async()=>{
    const response=await get('finance/analytics','?range=30d&routeId=united-stables-confidential-vault');
    expect(response.status).toBe(200);const body=await response.json();
    expect(body.strategy.attribution).toBe('shared_unitas_strategy');expect(body.strategy.assetSymbol).toBe('USDu');
    expect(body.strategy.points.length).toBeGreaterThanOrEqual(29);expect(body.strategy.flows.length).toBeGreaterThan(0);
    expect(body.strategy.latest.apy7d).toEqual(expect.any(Number));expect(body.strategy.latest.apy30d).toEqual(expect.any(Number));
    expect(body.operations.routeActivity).toHaveLength(1);expect(body.operations.routeActivity[0].routeId).toBe('united-stables-confidential-vault');
    expect((await get('finance/analytics','?routeId=missing')).status).toBe(422);
  });
  it('keeps Network cohort coverage, latency and explicit source windows consistent',async()=>{
    const response=await get('network/analytics','?range=24h&interval=hour');expect(response.status).toBe(200);
    const body=await response.json(),data=body.analytics;
    expect(data.requestCohort.requestsWithSubsequentReport).toBe(data.firstReportLatency.count);
    expect(data.requestCohort.requestsWithSubsequentReport).toBeLessThanOrEqual(data.requestCohort.requestCount);
    expect(data.series.reduce((sum:number,row:{SubmitTask:number})=>sum+row.SubmitTask,0)).toBe(116);
    expect((await get('network/analytics','?range=1y')).status).toBe(400);
    expect((await get('network/analytics','?privateKey=secret-input')).status).toBe(400);
  });
  it('serves strict paged Network events and documents their filters', async () => {
    const response=await get('network/events','?eventKind=ReportResult&limit=2');
    expect(response.status).toBe(200); const page=await response.json();
    expect(page.items).toHaveLength(2);expect(page.total).toBe(90);expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.items.every((event:{kind:string})=>event.kind==='ReportResult')).toBe(true);
    const document=await (await get('openapi.json')).json();
    expect(document.paths['/network/events'].get.parameters.map((p:{name:string})=>p.name)).toContain('fromBlock');
    expect(document.paths['/exports/metrics.csv'].get.parameters.map((p:{name:string})=>p.name)).toContain('snapshotId');
  });
  it.each(['?eventKind=SUCCESS','?fromBlock=01','?taskId=secret-value','?limit=1&limit=2','?privateKey=secret-value','?cursor=x&cursor=y'])(
    'rejects malformed Network query %s safely',async query=>{
      const response=await get('network/events',query);expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('secret-value');
    });
  it('guards range and cursor scope and refuses exports after a snapshot changes',async()=>{
    const first=await (await get('network/events','?limit=1')).json();
    expect((await get('network/events','?fromBlock=0')).status).toBe(422);
    expect((await get('network/events','?eventKind=ReportResult&limit=1&cursor='+first.nextCursor)).status).toBe(400);
    const response=await get('exports/metrics.csv','?domain=network&snapshotId='+'a'.repeat(64));
    expect(response.status).toBe(409);expect((await response.json()).code).toBe('SNAPSHOT_EXPIRED');
  });
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
    const routeId = (await getObservationSet()).finance.contracts[0].routeId;
    const response = await get("exports/metrics.csv", `?domain=finance&routeId=${encodeURIComponent(routeId)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("primusscope-finance-observations.csv");
    const text = await response.text();
    expect(text.split("\n")[0]).toContain("snapshot_id");
    expect(text.split("\n")[0]).toContain("source_id");
  });
});
