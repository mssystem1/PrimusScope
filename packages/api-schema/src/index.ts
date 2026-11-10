import { z } from "zod";

const UINT256_MAX = (1n << 256n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Accounting values and block identifiers must never cross JSON as floats. */
export const DecimalStringSchema = z.string().max(78).regex(DECIMAL).refine(
  (value) => !DECIMAL.test(value) || value.length > 78 || BigInt(value) <= UINT256_MAX,
  { message: "Value exceeds uint256." },
);
export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Expected an EVM address.");
export const HashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Expected a 32-byte hash.");
export const Sha256Schema = z.string().regex(/^[0-9a-fA-F]{64}$/, "Expected a SHA-256 digest.");
export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export const IdentifierSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);

type IssueContext = {
  addIssue: (issue: { code: "custom"; message: string; path: (string | number)[] }) => void;
};

function issue(ctx: IssueContext, message: string, path: (string | number)[]) {
  ctx.addIssue({ code: "custom", message, path });
}

function decimal(value: string): bigint | null {
  return value.length <= 78 && DECIMAL.test(value) ? BigInt(value) : null;
}

function timestamp(value: string): number | null {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export const CoverageSchema = z.object({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contractAddresses: z.array(AddressSchema).min(1).max(100),
  fromBlock: DecimalStringSchema,
  toBlock: DecimalStringSchema,
  fromTime: IsoTimestampSchema.nullable(),
  toTime: IsoTimestampSchema,
  observedAt: IsoTimestampSchema,
  completeForRegisteredContracts: z.boolean(),
  finality: z.literal("provider_reported_finalized"),
  sourceId: IdentifierSchema,
}).strict().superRefine((coverage, ctx) => {
  const low = decimal(coverage.fromBlock);
  const high = decimal(coverage.toBlock);
  if (low !== null && high !== null && low > high) {
    issue(ctx, "Coverage block range is reversed.", ["toBlock"]);
  }
  const lowTime = coverage.fromTime === null ? null : timestamp(coverage.fromTime);
  const highTime = timestamp(coverage.toTime);
  if (lowTime !== null && highTime !== null && lowTime > highTime) {
    issue(ctx, "Coverage time range is reversed.", ["toTime"]);
  }
  const addresses = coverage.contractAddresses.map((value) => value.toLowerCase());
  if (new Set(addresses).size !== addresses.length) {
    issue(ctx, "Coverage contains duplicate contracts.", ["contractAddresses"]);
  }
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const SharedEventSchema = z.object({
  id: IdentifierSchema,
  contractAddress: AddressSchema,
  blockNumber: DecimalStringSchema,
  blockHash: HashSchema,
  transactionHash: HashSchema,
  logIndex: DecimalStringSchema,
  timestamp: IsoTimestampSchema.nullable(),
  sourceId: IdentifierSchema,
}).strict();
export type SharedEvent = z.infer<typeof SharedEventSchema>;

export const FinanceEventKindSchema = z.enum([
  "AggregateDispatched", "AggregateFinalized", "AggregateCanceled", "StepAdvanced", "Recovered",
]);
export const FinanceEventSchema = SharedEventSchema.extend({
  kind: FinanceEventKindSchema,
  batchId: DecimalStringSchema,
});
export type FinanceEvent = z.infer<typeof FinanceEventSchema>;

export const NetworkEventKindSchema = z.enum([
  "SubmitTask", "ReportResult", "WithdrawBalance", "CallbackFailed",
]);
export const NetworkEventSchema = SharedEventSchema.extend({
  kind: NetworkEventKindSchema,
  taskId: HashSchema.nullable(),
}).superRefine((event, ctx) => {
  if (event.kind === "WithdrawBalance" ? event.taskId !== null : event.taskId === null) {
    issue(ctx, "Task identity must match the event's task cardinality.", ["taskId"]);
  }
});
export type NetworkEvent = z.infer<typeof NetworkEventSchema>;

/** Public selection over already validated Network observations. */
export const NetworkEventFiltersSchema = z.object({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  contractAddress: AddressSchema.optional(),
  fromBlock: DecimalStringSchema.optional(),
  toBlock: DecimalStringSchema.optional(),
  eventKind: NetworkEventKindSchema.optional(),
  taskId: HashSchema.optional(),
}).strict();
export type NetworkEventFilters = z.infer<typeof NetworkEventFiltersSchema>;

export const FinanceContractSchema = z.object({
  id: IdentifierSchema,
  routeId: IdentifierSchema,
  role: z.enum(["deposit", "redeem"]),
  address: AddressSchema,
  implementationAddress: AddressSchema,
  abiSha256: Sha256Schema,
}).strict();
export type FinanceContract = z.infer<typeof FinanceContractSchema>;

export const FinanceStateSampleSchema = z.object({
  contractAddress: AddressSchema,
  batchId: DecimalStringSchema,
  nativeStateCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  asOfBlock: DecimalStringSchema,
}).strict();
export type FinanceStateSample = z.infer<typeof FinanceStateSampleSchema>;

export const FinanceLatencySampleSchema = z.object({
  contractAddress: AddressSchema,
  batchId: DecimalStringSchema,
  seconds: DecimalStringSchema,
  dispatchedAt: IsoTimestampSchema,
  finalizedAt: IsoTimestampSchema,
}).strict().superRefine((sample, ctx) => {
  const start = timestamp(sample.dispatchedAt);
  const end = timestamp(sample.finalizedAt);
  const seconds = decimal(sample.seconds);
  if (start !== null && end !== null && seconds !== null
      && (end < start || (end - start) % 1000 !== 0 || BigInt((end - start) / 1000) !== seconds)) {
    issue(ctx, "Latency must equal the observed dispatch-to-finalization interval.", ["seconds"]);
  }
});
export type FinanceLatencySample = z.infer<typeof FinanceLatencySampleSchema>;

export const NetworkStateSampleSchema = z.object({
  taskId: HashSchema,
  nativeStatusCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  asOfBlock: DecimalStringSchema,
  submittedAt: IsoTimestampSchema.nullable(),
  cryptographicVerification: z.literal("not_run"),
}).strict();
export type NetworkStateSample = z.infer<typeof NetworkStateSampleSchema>;

export const SourceSchema = z.object({
  id: IdentifierSchema,
  label: z.string().min(1).max(160),
  kind: z.enum(["rpc", "official_frontend", "verified_source_metadata", "official_docs"]),
  url: z.string().url().superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      const sensitive = new Set(["apikey", "api_key", "api-key", "key", "token", "access_token", "auth", "authorization", "password", "secret", "signature"]);
      let hasCredential = false;
      url.searchParams.forEach((_, name) => { if (sensitive.has(name.toLowerCase())) hasCredential = true; });
      if (url.protocol !== "https:" || url.username || url.password || hasCredential) {
        issue(ctx, "Source links must be HTTPS and omit credentials.", []);
      }
    } catch {
      issue(ctx, "Expected a public HTTPS source URL.", []);
    }
  }),
}).strict();
export type Source = z.infer<typeof SourceSchema>;

export const StrategySampleSchema = z.object({
  blockNumber: DecimalStringSchema, blockHash: HashSchema, timestamp: IsoTimestampSchema,
  observedAt: IsoTimestampSchema, sourceUrl: z.enum(['https://bsc-mainnet.public.blastapi.io','https://bsc-rpc.publicnode.com']),
  totalAssetsRaw: DecimalStringSchema, totalSupplyRaw: DecimalStringSchema,
  exchangeRateRaw: DecimalStringSchema, unvestedRaw: DecimalStringSchema,
}).strict();
export const StrategyFlowSchema = z.object({
  id: IdentifierSchema, blockNumber: DecimalStringSchema, blockHash: HashSchema,
  transactionHash: HashSchema, logIndex: DecimalStringSchema, timestamp: IsoTimestampSchema,
  kind: z.enum(['Deposit','Withdraw']), assetsRaw: DecimalStringSchema, sharesRaw: DecimalStringSchema,
}).strict();
export const FinanceStrategySchema = z.object({
  schemaVersion: z.literal('1.0.0'), chainId: z.literal(56),
  attribution: z.literal('shared_unitas_strategy'),
  proxyAddress: AddressSchema, vaultAddress: AddressSchema, assetAddress: AddressSchema,
  assetSymbol: z.literal('USDu'), shareSymbol: z.literal('sUSDu'),
  assetDecimals: z.literal(18), shareDecimals: z.literal(18),
  samples: z.array(StrategySampleSchema).max(5000), flows: z.array(StrategyFlowSchema).max(20000),
  flowCoverage: z.object({fromBlock:DecimalStringSchema,toBlock:DecimalStringSchema,
    toBlockHash:HashSchema.optional(),
    fromTime:IsoTimestampSchema,toTime:IsoTimestampSchema,observedAt:IsoTimestampSchema,
    sourceUrl:z.enum(['https://bsc-mainnet.public.blastapi.io','https://bsc-rpc.publicnode.com','https://bsc.api.pocket.network']),
    sourceUrls:z.array(z.enum(['https://bsc-mainnet.public.blastapi.io','https://bsc-rpc.publicnode.com','https://bsc.api.pocket.network'])).min(1).max(3).optional(),complete:z.boolean()}).strict().nullable(),
}).strict();
export type FinanceStrategy = z.infer<typeof FinanceStrategySchema>;
export type StrategySample = z.infer<typeof StrategySampleSchema>;

export const FinanceObservationSchema = z.object({
  chainId: z.literal(56),
  contracts: z.array(FinanceContractSchema).min(1).max(100),
  coverage: CoverageSchema,
  events: z.array(FinanceEventSchema).max(100_000),
  stateSamples: z.array(FinanceStateSampleSchema).max(10_000),
  latencySamples: z.array(FinanceLatencySampleSchema).max(10_000),
  strategy: FinanceStrategySchema.optional(),
}).strict();
export type FinanceObservation = z.infer<typeof FinanceObservationSchema>;

export const NetworkObservationSchema = z.object({
  chainId: z.literal(8453),
  taskContract: AddressSchema,
  coverage: CoverageSchema,
  events: z.array(NetworkEventSchema).max(100_000),
  stateSamples: z.array(NetworkStateSampleSchema).max(10_000),
}).strict();
export type NetworkObservation = z.infer<typeof NetworkObservationSchema>;

function validateEvents(events: SharedEvent[], coverage: Coverage, ctx: IssueContext, path: string[]) {
  const addresses = new Set(coverage.contractAddresses.map((value) => value.toLowerCase()));
  const ids = new Set<string>();
  const identities = new Set<string>();
  const blockHashes = new Map<string, string>();
  const transactionBlocks = new Map<string, string>();
  const positions = new Map<string, string>();
  const low = decimal(coverage.fromBlock);
  const high = decimal(coverage.toBlock);
  for (const [index, event] of events.entries()) {
    const base = [...path, "events", index];
    if (!addresses.has(event.contractAddress.toLowerCase())) {
      issue(ctx, "Event contract is outside registered coverage.", [...base, "contractAddress"]);
    }
    const block = decimal(event.blockNumber);
    if (block !== null && low !== null && high !== null && (block < low || block > high)) {
      issue(ctx, "Event block is outside the covered range.", [...base, "blockNumber"]);
    }
    if (event.sourceId !== coverage.sourceId) {
      issue(ctx, "Event provenance differs from its coverage source.", [...base, "sourceId"]);
    }
    const identity = [event.contractAddress.toLowerCase(), event.transactionHash.toLowerCase(), event.logIndex].join(":");
    if (ids.has(event.id) || identities.has(identity)) {
      issue(ctx, "Snapshot contains a duplicate canonical event.", base);
    }
    ids.add(event.id);
    identities.add(identity);
    const hash = event.blockHash.toLowerCase();
    const transaction = event.transactionHash.toLowerCase();
    const blockIdentity = `${event.blockNumber}:${hash}`;
    const position = `${hash}:${event.logIndex}`;
    const owner = `${event.contractAddress.toLowerCase()}:${transaction}`;
    if ((blockHashes.has(event.blockNumber) && blockHashes.get(event.blockNumber) !== hash)
        || (transactionBlocks.has(transaction) && transactionBlocks.get(transaction) !== blockIdentity)
        || (positions.has(position) && positions.get(position) !== owner)) {
      issue(ctx, "Snapshot contains inconsistent canonical block or log identity.", base);
    }
    blockHashes.set(event.blockNumber, hash);
    transactionBlocks.set(transaction, blockIdentity);
    positions.set(position, owner);
    const eventTime = event.timestamp === null ? null : timestamp(event.timestamp);
    const fromTime = coverage.fromTime === null ? null : timestamp(coverage.fromTime);
    const toTime = timestamp(coverage.toTime);
    if (eventTime !== null && toTime !== null && (eventTime > toTime || (fromTime !== null && eventTime < fromTime))) {
      issue(ctx, "Event timestamp is outside its covered range.", [...base, "timestamp"]);
    }
  }
}

export const ObservationSetSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  snapshotId: Sha256Schema,
  generatedAt: IsoTimestampSchema,
  finance: FinanceObservationSchema,
  network: NetworkObservationSchema,
  sources: z.array(SourceSchema).min(1).max(100),
  features: z.object({
    privatePositions: z.literal("unavailable"),
    attestationVerification: z.literal("not_implemented"),
    developerTelemetry: z.literal("not_configured"),
  }).strict(),
}).strict().superRefine((snapshot, ctx) => {
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  if (sourceById.size !== snapshot.sources.length) issue(ctx, "Source identifiers must be unique.", ["sources"]);
  for (const [domain, observation] of [["finance", snapshot.finance], ["network", snapshot.network]] as const) {
    const coverage = observation.coverage;
    if (coverage.chainId !== observation.chainId) issue(ctx, "Coverage chain does not match its domain.", [domain, "coverage", "chainId"]);
    if (sourceById.get(coverage.sourceId)?.kind !== "rpc") issue(ctx, "Coverage must reference its registered RPC source.", [domain, "coverage", "sourceId"]);
    const observedAt = timestamp(coverage.observedAt);
    const generatedAt = timestamp(snapshot.generatedAt);
    if (observedAt !== null && generatedAt !== null && observedAt > generatedAt) issue(ctx, "Snapshot generation predates observation.", ["generatedAt"]);
    validateEvents(observation.events, coverage, ctx, [domain]);
  }
  const financeAddresses = snapshot.finance.contracts.map((contract) => contract.address.toLowerCase());
  const financeIds = snapshot.finance.contracts.map((contract) => contract.id);
  if (new Set(financeAddresses).size !== financeAddresses.length || new Set(financeIds).size !== financeIds.length) issue(ctx, "Finance contracts must be unique.", ["finance", "contracts"]);
  const financeSet = new Set(financeAddresses);
  const coverageSet = new Set(snapshot.finance.coverage.contractAddresses.map((value) => value.toLowerCase()));
  if (financeSet.size !== coverageSet.size || [...financeSet].some((address) => !coverageSet.has(address))) issue(ctx, "Finance coverage must match its registered contracts.", ["finance", "coverage", "contractAddresses"]);
  if (snapshot.network.coverage.contractAddresses.length !== 1 || snapshot.network.coverage.contractAddresses[0]?.toLowerCase() !== snapshot.network.taskContract.toLowerCase()) issue(ctx, "Network coverage must match its task contract.", ["network", "coverage", "contractAddresses"]);
  const maxFinanceBlock = decimal(snapshot.finance.coverage.toBlock);
  for (const [key, samples] of [["stateSamples", snapshot.finance.stateSamples], ["latencySamples", snapshot.finance.latencySamples]] as const) {
    for (const [index, sample] of samples.entries()) {
      if (!financeSet.has(sample.contractAddress.toLowerCase())) issue(ctx, "Sample contract is not registered.", ["finance", key, index, "contractAddress"]);
      if ("asOfBlock" in sample) {
        const block = decimal(sample.asOfBlock);
        if (block !== null && maxFinanceBlock !== null && block > maxFinanceBlock) issue(ctx, "State sample exceeds the snapshot watermark.", ["finance", key, index, "asOfBlock"]);
      }
    }
  }
  const maxNetworkBlock = decimal(snapshot.network.coverage.toBlock);
  for (const [index, sample] of snapshot.network.stateSamples.entries()) {
    const block = decimal(sample.asOfBlock);
    if (block !== null && maxNetworkBlock !== null && block > maxNetworkBlock) issue(ctx, "State sample exceeds the snapshot watermark.", ["network", "stateSamples", index, "asOfBlock"]);
  }
});
export type ObservationSet = z.infer<typeof ObservationSetSchema>;

export const AnalyticsRangeSchema = z.enum(['all', '24h', '7d', '30d', 'custom']);
export const AnalyticsIntervalSchema = z.enum(['hour', 'day']);
export const UtcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Use a real UTC calendar date.');
export const AnalyticsSelectionFieldsSchema = z.object({
  range: AnalyticsRangeSchema.optional(), interval: AnalyticsIntervalSchema.optional(),
  from: UtcDateSchema.optional(), to: UtcDateSchema.optional(),
});
export function refineAnalyticsSelection(value: z.infer<typeof AnalyticsSelectionFieldsSchema>, ctx: z.RefinementCtx) {
  if (value.range === 'custom') {
    if (!value.from || !value.to) ctx.addIssue({ code: 'custom', message: 'Custom dates require both from and to.', path: ['from'] });
    else {
      const span = Date.parse(value.to) - Date.parse(value.from);
      if (span < 0 || span >= 366 * 86400000) ctx.addIssue({ code: 'custom', message: 'Choose an ordered range of at most 366 UTC days.', path: ['to'] });
    }
  } else if (value.from || value.to) ctx.addIssue({ code: 'custom', message: 'Dates require range=custom.', path: ['range'] });
}
export const AnalyticsSelectionSchema = AnalyticsSelectionFieldsSchema.strict().superRefine(refineAnalyticsSelection);
export type AnalyticsSelection = z.infer<typeof AnalyticsSelectionSchema>;

export const ApiErrorCodeSchema = z.enum([
  "INVALID_IDENTIFIER", "AMBIGUOUS_IDENTIFIER", "UNSUPPORTED_SCOPE", "NOT_INDEXED",
  "NOT_FOUND_IN_COVERAGE", "SOURCE_UNAVAILABLE", "RATE_LIMITED", "SNAPSHOT_EXPIRED",
  "INVALID_QUERY", "INTERNAL_ERROR",
  "INVALID_FILTER", "INVALID_CURSOR", "INVALID_TIME", "RANGE_TOO_LARGE",
  "PAYLOAD_TOO_LARGE", "METHOD_NOT_ALLOWED", "NOT_FOUND", "UNSUPPORTED_CONFIGURATION", "PUBLICATION_QUARANTINED",
]);
export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().min(1).max(240),
  requestId: IdentifierSchema,
  retryable: z.boolean(),
}).strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;
