import { describe, expect, it } from "vitest";
import {
  AddressSchema, ApiErrorSchema, CoverageSchema, DecimalStringSchema,
  FinanceLatencySampleSchema, HashSchema, IsoTimestampSchema, NetworkEventSchema,
  ObservationSetSchema, SourceSchema,
  type FinanceEvent, type ObservationSet,
} from "./index";

const address = (pair: string) => `0x${pair.repeat(20)}`;
const hash = (pair: string) => `0x${pair.repeat(32)}`;
const FINANCE = address("11");
const NETWORK = address("22");

function financeEvent(): FinanceEvent {
  return {
    id: "finance:56:event-1", contractAddress: FINANCE, blockNumber: "11",
    blockHash: hash("aa"), transactionHash: hash("bb"), logIndex: "0",
    timestamp: "2026-11-09T00:01:00Z", sourceId: "bsc-rpc",
    kind: "AggregateDispatched", batchId: "146",
  };
}

function fixture(): ObservationSet {
  return {
    schemaVersion: "1.0.0", snapshotId: "a".repeat(64), generatedAt: "2026-11-09T00:13:00Z",
    finance: {
      chainId: 56,
      contracts: [{ id: "finance-u-deposit", routeId: "united-stables-confidential-vault", role: "deposit",
        address: FINANCE, implementationAddress: address("33"), abiSha256: "b".repeat(64) }],
      coverage: { chainId: 56, contractAddresses: [FINANCE], fromBlock: "10", toBlock: "20",
        fromTime: "2026-11-09T00:00:00Z", toTime: "2026-11-09T00:10:00Z",
        observedAt: "2026-11-09T00:12:00Z", completeForRegisteredContracts: true,
        finality: "provider_reported_finalized", sourceId: "bsc-rpc" },
      events: [financeEvent()],
      stateSamples: [{ contractAddress: FINANCE, batchId: "146", nativeStateCode: 2, asOfBlock: "20" }],
      latencySamples: [{ contractAddress: FINANCE, batchId: "146", seconds: "55",
        dispatchedAt: "2026-11-09T00:01:00Z", finalizedAt: "2026-11-09T00:01:55Z" }],
    },
    network: {
      chainId: 8453, taskContract: NETWORK,
      coverage: { chainId: 8453, contractAddresses: [NETWORK], fromBlock: "100", toBlock: "200",
        fromTime: null, toTime: "2026-11-09T00:10:00Z", observedAt: "2026-11-09T00:12:00Z",
        completeForRegisteredContracts: true, finality: "provider_reported_finalized", sourceId: "base-rpc" },
      events: [{ id: "network:8453:event-1", contractAddress: NETWORK, blockNumber: "120",
        blockHash: hash("cc"), transactionHash: hash("dd"), logIndex: "0", timestamp: null,
        sourceId: "base-rpc", kind: "SubmitTask", taskId: hash("ee") }],
      stateSamples: [{ taskId: hash("ee"), nativeStatusCode: 1, asOfBlock: "200",
        submittedAt: "2026-11-09T00:01:00Z", cryptographicVerification: "not_run" }],
    },
    sources: [
      { id: "bsc-rpc", label: "BSC public RPC", kind: "rpc", url: "https://bsc-rpc.publicnode.com" },
      { id: "base-rpc", label: "Base public RPC", kind: "rpc", url: "https://base-rpc.publicnode.com" },
    ],
    features: { privatePositions: "unavailable", attestationVerification: "not_implemented", developerTelemetry: "not_configured" },
  };
}

describe("safe scalar contracts", () => {
  it("preserves exact uint256 values as decimal strings", () => {
    const maximum = ((1n << 256n) - 1n).toString();
    expect(DecimalStringSchema.parse(maximum)).toBe(maximum);
    expect(DecimalStringSchema.parse("0")).toBe("0");
    expect(DecimalStringSchema.safeParse((1n << 256n).toString()).success).toBe(false);
  });

  it("rejects floats, numeric coercion and noncanonical decimal encodings without throwing", () => {
    for (const value of [1, 1.2, -1, "-1", "01", "1.0", "1e18", "0x01", "", "x", "9".repeat(1000)]) {
      expect(DecimalStringSchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires EVM addresses and full transaction hashes", () => {
    expect(AddressSchema.safeParse(FINANCE).success).toBe(true);
    expect(HashSchema.safeParse(hash("aa")).success).toBe(true);
    expect(AddressSchema.safeParse("0xabc").success).toBe(false);
    expect(HashSchema.safeParse(FINANCE).success).toBe(false);
  });

  it("requires a real ISO instant with timezone", () => {
    expect(IsoTimestampSchema.safeParse("2026-11-09T04:00:00+04:00").success).toBe(true);
    for (const value of ["2026-11-09", "2026-11-09T00:00:00", "2026-02-30T00:00:00Z", "yesterday"]) {
      expect(IsoTimestampSchema.safeParse(value).success).toBe(false);
    }
  });

  it("prevents credentials and non-HTTPS links in source metadata", () => {
    const source = fixture().sources[0]!;
    for (const url of ["http://source.example", "file:///tmp/key", "https://user:secret@source.example",
      "https://source.example?apikey=secret", "https://source.example?access_token=secret"]) {
      expect(SourceSchema.safeParse({ ...source, url }).success).toBe(false);
    }
    expect(SourceSchema.safeParse({ ...source, url: "https://source.example/contract#code" }).success).toBe(true);
  });
});

describe("observation snapshot boundary", () => {
  it("accepts scoped public observations without converting missing times or values", () => {
    const input = fixture();
    const result = ObservationSetSchema.parse(input);
    expect(result.network.events[0]!.timestamp).toBeNull();
    expect(result.finance.latencySamples[0]!.seconds).toBe("55");
    expect(result).toEqual(input);
  });

  it("rejects private or unexpected fields at every object layer", () => {
    const input = fixture();
    expect(ObservationSetSchema.safeParse({ ...input, decryptedBalance: "123" }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, finance: { ...input.finance,
      events: [{ ...input.finance.events[0]!, amount: "123", participant: FINANCE }] } }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, network: { ...input.network,
      stateSamples: [{ ...input.network.stateSamples[0]!, taskResults: [{ body: "private" }] }] } }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, features: { ...input.features, walletPermit: "private" } }).success).toBe(false);
  });

  it("keeps domain chain coverage explicit", () => {
    const input = fixture();
    expect(ObservationSetSchema.safeParse({ ...input, finance: { ...input.finance, chainId: 8453 } }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, finance: { ...input.finance,
      coverage: { ...input.finance.coverage, chainId: 8453 } } }).success).toBe(false);
  });

  it("rejects reversed block/time scopes and duplicated coverage addresses", () => {
    const base = fixture().finance.coverage;
    expect(CoverageSchema.safeParse({ ...base, fromBlock: "21" }).success).toBe(false);
    expect(CoverageSchema.safeParse({ ...base, fromTime: "2026-11-09T00:11:00Z" }).success).toBe(false);
    expect(CoverageSchema.safeParse({ ...base, contractAddresses: [FINANCE, FINANCE.toUpperCase().replace("0X", "0x")] }).success).toBe(false);
  });

  it("rejects events outside registered addresses or block ranges", () => {
    const input = fixture();
    for (const event of [{ ...financeEvent(), contractAddress: NETWORK }, { ...financeEvent(), blockNumber: "21" }]) {
      expect(ObservationSetSchema.safeParse({ ...input, finance: { ...input.finance, events: [event] } }).success).toBe(false);
    }
  });

  it("rejects aliases of the same canonical event", () => {
    const input = fixture();
    input.finance.events.push({ ...financeEvent(), id: "alias" });
    expect(ObservationSetSchema.safeParse(input).success).toBe(false);
  });

  it("rejects mixtures of conflicting canonical blocks or global log positions", () => {
    const input = fixture();
    const initial = financeEvent();
    for (const second of [
      { ...initial, id: "event-2", transactionHash: hash("ee"), blockHash: hash("ff"), logIndex: "1" },
      { ...initial, id: "event-2", transactionHash: hash("ee") },
      { ...initial, id: "event-2", blockNumber: "12", blockHash: hash("ff"), logIndex: "1" },
    ]) {
      expect(ObservationSetSchema.safeParse({ ...input, finance: { ...input.finance, events: [initial, second] } }).success).toBe(false);
    }
  });

  it("requires accurate registered source references", () => {
    const input = fixture();
    expect(ObservationSetSchema.safeParse({ ...input, sources: [input.sources[0]!] }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, sources: [...input.sources, input.sources[0]!] }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, sources: [{ ...input.sources[0]!, kind: "official_docs" }, input.sources[1]!] }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, finance: { ...input.finance,
      events: [{ ...financeEvent(), sourceId: "base-rpc" }] } }).success).toBe(false);
  });

  it("checks contract sets rather than silently expanding advertised coverage", () => {
    const input = fixture();
    expect(ObservationSetSchema.safeParse({ ...input, finance: { ...input.finance,
      coverage: { ...input.finance.coverage, contractAddresses: [FINANCE, NETWORK] } } }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, network: { ...input.network,
      taskContract: FINANCE } }).success).toBe(false);
  });

  it("rejects state samples beyond the snapshot watermark", () => {
    const input = fixture();
    input.finance.stateSamples[0]!.asOfBlock = "21";
    expect(ObservationSetSchema.safeParse(input).success).toBe(false);
    const next = fixture();
    next.network.stateSamples[0]!.asOfBlock = "201";
    expect(ObservationSetSchema.safeParse(next).success).toBe(false);
  });

  it("does not allow a signature-verification claim when no check ran", () => {
    const input = fixture();
    expect(ObservationSetSchema.safeParse({ ...input, network: { ...input.network,
      stateSamples: [{ ...input.network.stateSamples[0]!, cryptographicVerification: "verified" }] } }).success).toBe(false);
    expect(ObservationSetSchema.safeParse({ ...input, features: { ...input.features,
      privatePositions: "available" } }).success).toBe(false);
  });

  it("does not create fresh observations by resetting only the generated time", () => {
    const input = fixture();
    const later = ObservationSetSchema.parse({ ...input, generatedAt: "2026-11-10T00:00:00Z" });
    expect(later.finance.coverage.observedAt).toBe("2026-11-09T00:12:00Z");
    expect(ObservationSetSchema.safeParse({ ...input, generatedAt: "2026-11-09T00:11:00Z" }).success).toBe(false);
  });

  it("checks observed event timestamps against coverage when they are known", () => {
    const input = fixture();
    expect(ObservationSetSchema.safeParse({ ...input, finance: { ...input.finance,
      events: [{ ...financeEvent(), timestamp: "2026-11-09T00:11:00Z" }] } }).success).toBe(false);
  });
});

describe("metric semantics", () => {
  it("keeps one-task events distinct from multi-task withdrawals", () => {
    const event = fixture().network.events[0]!;
    expect(NetworkEventSchema.safeParse({ ...event, taskId: null }).success).toBe(false);
    expect(NetworkEventSchema.safeParse({ ...event, kind: "WithdrawBalance" }).success).toBe(false);
    expect(NetworkEventSchema.safeParse({ ...event, kind: "WithdrawBalance", taskId: null }).success).toBe(true);
  });

  it("checks exact public latency rather than accepting an invented duration", () => {
    const sample = fixture().finance.latencySamples[0]!;
    expect(FinanceLatencySampleSchema.safeParse({ ...sample, seconds: "56" }).success).toBe(false);
    expect(FinanceLatencySampleSchema.safeParse({ ...sample, finalizedAt: "2026-11-09T00:00:59Z" }).success).toBe(false);
    expect(FinanceLatencySampleSchema.safeParse({ ...sample, finalizedAt: "2026-11-09T00:01:55.500Z" }).success).toBe(false);
  });

  it("keeps public API errors typed and rejects stack/payload leakage fields", () => {
    const error = { code: "NOT_FOUND_IN_COVERAGE", message: "No matching object in this recorded scope.", requestId: "request-1", retryable: false };
    expect(ApiErrorSchema.safeParse(error).success).toBe(true);
    expect(ApiErrorSchema.safeParse({ ...error, stack: "internal" }).success).toBe(false);
    expect(ApiErrorSchema.safeParse({ ...error, code: "UNKNOWN_EXTERNAL_ERROR" }).success).toBe(false);
  });
});
