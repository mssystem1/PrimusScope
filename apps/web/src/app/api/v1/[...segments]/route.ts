import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AddressSchema, DecimalStringSchema, HashSchema,
  CoverageSchema, FinanceEventSchema, NetworkEventSchema, ApiErrorSchema,
} from "@primusscope/api-schema";
import {
  getOverview, getObservationSet, getSources, getFinanceVaults, getFinanceVault,
  getFinanceBatches, getFinanceBatch, getNetworkSummary, getNetworkTask,
  lookupIdentifier, exportMetricsCsv, getServingState, getServingMode, getIndexerStatus, PublicIndexerStatusSchema,
} from "@primusscope/data";
import { HttpError, errorResponse, jsonResponse, readJson, readQuery } from "../../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ segments: string[] }> };
const emptyQuery = z.object({}).strict();
const positiveIntegerParameter = z.string().regex(/^[1-9][0-9]{0,15}$/)
  .pipe(z.coerce.number<string>().int().positive());
const pageQuery = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: positiveIntegerParameter.pipe(z.number().max(100)).optional(),
  contractAddress: AddressSchema.optional(),
}).strict();
const lookupSchema = z.object({
  identifier: z.string().trim().min(1).max(256),
  type: z.enum(["auto", "task", "transaction", "contract"]).optional(),
  chainId: z.number().int().positive().optional(),
  contractAddress: AddressSchema.optional(),
}).strict();

const definitions: Record<string, {label: string; unit: string; formula: string; caveat: string}> = {
  "finance.batch_events": {label: "Observed batch events", unit: "events",
    formula: "Count canonical recognized batch event identities within the recorded registered-contract block scope.",
    caveat: "Events are not users, private requests, amounts, or proof verifications."},
  "finance.finalized_batches": {label: "Observed finalized batches", unit: "batches",
    formula: "Distinct chain, aggregator and batch identifiers with AggregateFinalized in the recorded scope.",
    caveat: "Batch finalization does not establish that every participant claimed."},
  "finance.batch_dispatch_latency": {label: "Sample dispatch-to-finalization interval", unit: "seconds",
    formula: "Finalization event block timestamp minus dispatch event block timestamp for a reconciled batch.",
    caveat: "One public batch sample; excludes private waiting and user claims. Not a network percentile."},
  "network.task_requests": {label: "Observed task requests", unit: "tasks",
    formula: "Distinct chain, task-contract and task identifiers in SubmitTask observations within the recorded scope.",
    caveat: "Contract-mode requests only; excludes unobserved/off-chain SDK usage."},
  "network.attestor_reports": {label: "Observed attestor report events", unit: "events",
    formula: "Count canonical ReportResult event identities in the recorded scope.",
    caveat: "An attestor report is not a completed task or cryptographically verified attestation."},
};

function openApi() {
  const get = (summary: string) => ({get: {summary, responses: {"200": {description: "Recorded public observations with coverage and freshness"},
    "400": {description: "Invalid query"}, "503": {description: "Observation store unavailable"}}}});
  return {
    openapi: "3.1.0", info: {title: "PrimusScope public observations API", version: "0.1.0",
    description: "Source-scoped public observations. Serving mode is explicitly recorded or locally indexed; no global Primus census or continuously running worker is implied. Public reads require no authentication or RPC credentials."},
    servers: [{url: "/api/v1"}],
    paths: {
      "/overview": get("Separate Finance and Network summaries"),
      "/finance/vaults": get("Supported Finance routes and source availability"),
      "/finance/vaults/{routeId}/batches": {get: {
        summary: "Observed batches scoped to one supported vault route",
        parameters: [{name:"routeId",in:"path",required:true,schema:{type:"string"}},
          {name:"limit",in:"query",schema:{type:"integer",minimum:1,maximum:100}},
          {name:"cursor",in:"query",schema:{type:"string",maxLength:2048}}],
        responses:{"200":{description:"Snapshot-bound batch page"},"400":{description:"Invalid cursor or query"},"409":{description:"Snapshot changed"}}
      }},
      "/network/summary": get("Separate request/report counts and block-interval activity"),
      "/network/tasks/{chainId}/{contract}/{taskId}": {get: {
        summary:"Exact recorded task and separately observed native state",
        parameters:["chainId","contract","taskId"].map(name=>({name,in:"path",required:true,schema:{type:"string"}})),
        responses:{"200":{description:"Task observations; cryptographic verification not run"},"404":{description:"Not found in recorded scope"},"422":{description:"Outside supported scope"}}
      }},
      "/explore/lookup": {post: {summary: "Type-aware public identifier lookup",
        requestBody: {required:true,content:{"application/json":{schema:z.toJSONSchema(lookupSchema)}}},
        responses:{"200":{description:"Zero or more recorded matches with coverage"},"400":{description:"Invalid identifier"},"413":{description:"Body exceeds 2048 bytes"}}
      }},
      "/status/sources": get("Recorded source coverage and staleness"),
      "/status/indexer": get("Local indexer checkpoints, source lag and publication status; readable during quarantine"),
      "/exports/metrics.csv": get("Source-labelled observed event rows, respecting domain and route filters"),
    },
    components: {schemas: {
      Coverage:z.toJSONSchema(CoverageSchema), FinanceEvent:z.toJSONSchema(FinanceEventSchema),
      NetworkEvent:z.toJSONSchema(NetworkEventSchema), ApiError:z.toJSONSchema(ApiErrorSchema),
      IndexerStatus:z.toJSONSchema(PublicIndexerStatusSchema),
    }},
  };
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const { segments: parts } = await context.params;
    const path = parts.join("/");
    const url = request.nextUrl;
    if (path === "overview") { readQuery(url, emptyQuery); return jsonResponse(getOverview()); }
    if (path === "health") {
      readQuery(url, emptyQuery); const {snapshot,mode} = getServingState();
      return jsonResponse({status:"snapshot_available",mode,snapshotId:snapshot.snapshotId});
    }
    if (path === "registry/contracts") {
      readQuery(url, emptyQuery); const {snapshot,mode} = getServingState();
      return jsonResponse({snapshotId:snapshot.snapshotId,mode,finance:snapshot.finance.contracts,
        network:[{chainId:8453,address:snapshot.network.taskContract}],sources:snapshot.sources});
    }
    if (path === "finance/vaults") { readQuery(url, emptyQuery); return jsonResponse(getFinanceVaults()); }
    if (parts[0] === "finance" && parts[1] === "vaults" && parts.length === 3) {
      readQuery(url, emptyQuery); return jsonResponse(getFinanceVault(parts[2]));
    }
    if (parts[0] === "finance" && parts[1] === "vaults" && parts[3] === "batches" && parts.length === 4) {
      return jsonResponse(getFinanceBatches({...readQuery(url, pageQuery),routeId:parts[2]}));
    }
    if (parts[0] === "finance" && parts[1] === "batches" && parts.length === 4) {
      readQuery(url, emptyQuery); AddressSchema.parse(parts[2]); DecimalStringSchema.parse(parts[3]);
      return jsonResponse(getFinanceBatch(parts[2],parts[3]));
    }
    if (path === "network/summary") {
      const query = readQuery(url,z.object({chainId:positiveIntegerParameter.optional(),contractAddress:AddressSchema.optional()}).strict());
      return jsonResponse(getNetworkSummary(query));
    }
    if (parts[0] === "network" && parts[1] === "tasks" && parts.length === 5) {
      readQuery(url,emptyQuery);
      const chainId=positiveIntegerParameter.parse(parts[2]);AddressSchema.parse(parts[3]);HashSchema.parse(parts[4]);
      return jsonResponse(getNetworkTask(chainId,parts[3],parts[4]));
    }
    if (path === "sources" || path === "status/sources") { readQuery(url,emptyQuery);return jsonResponse(getSources()); }
    if (path === "status/indexer") { readQuery(url,emptyQuery);return jsonResponse(getIndexerStatus()); }
    if (parts[0] === "metrics" && parts[2] === "definition" && parts.length === 3) {
      readQuery(url,emptyQuery);
      if (!Object.hasOwn(definitions,parts[1])) throw new HttpError("NOT_FOUND","No supported metric definition matches that key.",404);
      const definition=definitions[parts[1]];
      return jsonResponse({key:parts[1],definitionVersion:"1.0.0",mode:getServingMode(),...definition});
    }
    if (path === "exports/metrics.csv") {
      const query=readQuery(url,z.object({domain:z.enum(["finance","network"]).optional(),routeId:z.string().min(1).max(100).optional(),contractAddress:AddressSchema.optional()}).strict());
      return new NextResponse(exportMetricsCsv(query),{headers:{"Content-Type":"text/csv; charset=utf-8",
        "Content-Disposition":`attachment; filename="primusscope-${query.domain??"finance"}-observations.csv"`,"Cache-Control":"no-store",
        "X-PrimusScope-Data-Mode":getServingMode().replaceAll("_","-")}});
    }
    if (path === "openapi.json") { readQuery(url,emptyQuery);return jsonResponse(openApi()); }
    if (path === "explore/lookup") throw new HttpError("METHOD_NOT_ALLOWED","Use POST for identifier lookup.",405);
    throw new HttpError("NOT_FOUND","This API resource is not available.",404);
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const {segments}=await context.params;
    if (segments.join("/")!=="explore/lookup") throw new HttpError("METHOD_NOT_ALLOWED","This resource accepts read-only GET requests.",405);
    readQuery(request.nextUrl,emptyQuery);
    return jsonResponse(lookupIdentifier(lookupSchema.parse(await readJson(request))));
  } catch (error) { return errorResponse(error); }
}
