#!/usr/bin/env python3
"""Read-only, bounded Base RPC feasibility probe; not a production indexer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from rpc_client import JsonRpcClient, RpcError
from log_scan import scan_logs


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
HEX_BYTES = re.compile(r"0x(?:[0-9a-fA-F]{2})*")
QUANTITY = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)")
HASH = re.compile(r"0x[0-9a-fA-F]{64}")
EIP1967_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"


def quantity(value: object) -> int:
    if not isinstance(value, str) or len(value) > 66 or not QUANTITY.fullmatch(value):
        raise RpcError("INVALID_CHAIN_DATA")
    return int(value, 16)


def byte_string(value: object, length: int | None = None) -> bytes:
    if not isinstance(value, str) or not HEX_BYTES.fullmatch(value):
        raise RpcError("INVALID_CHAIN_DATA")
    result = bytes.fromhex(value[2:])
    if length is not None and len(result) != length:
        raise RpcError("INVALID_CHAIN_DATA")
    return result


def source_manifest() -> tuple[dict, list]:
    source_path = HERE / "sources" / "base-task-source.json"
    source = json.loads(source_path.read_text())
    abi_path = source_path.parent / source["selectedAbi"]["path"]
    # The input is a checked-in discovery source, never a remote/caller URL.
    if abi_path.resolve().parent != source_path.parent.resolve():
        raise RpcError("INVALID_SOURCE_MANIFEST")
    abi_bytes = abi_path.read_bytes()
    if hashlib.sha256(abi_bytes).hexdigest() != source["selectedAbi"]["sha256"]:
        raise RpcError("ABI_INTEGRITY_MISMATCH")
    abi = json.loads(abi_bytes)
    if source["chainId"] != 8453 or not re.fullmatch(r"0x[0-9a-fA-F]{40}", source["address"]):
        raise RpcError("INVALID_SOURCE_MANIFEST")
    for entry in abi:
        if entry["type"] == "function" and entry.get("stateMutability") != "view":
            raise RpcError("VALUE_MOVING_ABI_FORBIDDEN")
    return source, abi


def project_task_state(result: object, abi: list, source: dict) -> dict:
    """Project only native state/time; never serialize the full taskResult."""
    raw = byte_string(result)
    function = next(e for e in abi if e.get("name") == "queryTask")
    components = function["outputs"][0]["components"]
    if len(raw) < 32 * (1 + len(components)) or len(raw) % 32:
        raise RpcError("INVALID_TASK_STATE_ENCODING")
    # One dynamic output tuple has a canonical leading offset of one word.
    if int.from_bytes(raw[:32], "big") != 32:
        raise RpcError("INVALID_TASK_STATE_ENCODING")
    fields = {c["name"]: i for i, c in enumerate(components)}

    def word(name: str) -> int:
        offset = 32 + 32 * fields[name]
        return int.from_bytes(raw[offset:offset + 32], "big")

    # Validate top-level dynamic offsets without parsing/re-emitting their data.
    for name in ("templateId", "attestors", "taskResults"):
        offset = word(name)
        if offset % 32 or offset < 32 * len(components) or 32 + offset + 32 > len(raw):
            raise RpcError("INVALID_TASK_STATE_ENCODING")
    status, submitted = word("taskStatus"), word("submittedAt")
    if status > 255 or word("tokenSymbol") > 255 or submitted >= 2**64:
        raise RpcError("INVALID_TASK_STATE_ENCODING")
    return {
        "nativeStatusCode": status,
        "sourceDocumentedName": source["sourceDocumentedTaskStatuses"].get(str(status), "UNKNOWN_NATIVE_ENUM"),
        "submittedAtUnix": str(submitted),
        "taskRecordPresence": "observed_timestamp" if submitted else "not_confirmed",
        "projection": "minimal_tuple_head_only; full attestation not decoded or retained",
        "cryptographicVerification": "not_run",
    }


def block_header(value: object) -> dict:
    if not isinstance(value, dict) or not HASH.fullmatch(str(value.get("hash", ""))):
        raise RpcError("INVALID_BLOCK_HEADER")
    return {
        "number": quantity(value.get("number")),
        "hash": value["hash"].lower(),
        "timestampUnix": str(quantity(value.get("timestamp"))),
    }


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


class DeadlineClient:
    def __init__(self, client: JsonRpcClient, deadline: float, min_interval_seconds: float = 0):
        self.client = client
        self.deadline = deadline
        self.min_interval_seconds = min_interval_seconds
        self.last_start: float | None = None

    def call(self, method: str, params: list) -> object:
        now = time.monotonic()
        wait = max(0, self.last_start + self.min_interval_seconds - now) if self.last_start is not None else 0
        # Include pacing before starting another bounded operation. Quota/access
        # failures still stop; pacing is not an automatic retry loop.
        if now + wait + self.client.timeout_seconds + 0.5 > self.deadline:
            raise RpcError("RUN_DEADLINE_EXHAUSTED")
        if wait:
            time.sleep(wait)
        self.last_start = time.monotonic()
        return self.client.call(method, params)


def receipt_projection(receipt: object, event: dict) -> dict:
    if not isinstance(receipt, dict):
        raise RpcError("RECEIPT_NOT_AVAILABLE")
    if (str(receipt.get("transactionHash", "")).lower() != event["transactionHash"].lower()
            or str(receipt.get("blockHash", "")).lower() != event["blockHash"].lower()
            or quantity(receipt.get("blockNumber")) != event["blockNumber"]):
        raise RpcError("RECEIPT_CANONICAL_MISMATCH")
    if quantity(receipt.get("status")) != 1:
        raise RpcError("RECEIPT_EVENT_STATUS_MISMATCH")
    logs = receipt.get("logs")
    if not isinstance(logs, list):
        raise RpcError("INVALID_RECEIPT")
    matches = [log for log in logs if isinstance(log, dict)
               and log.get("logIndex") == hex(event["logIndex"])
               and str(log.get("address", "")).lower() == event["address"].lower()
               and isinstance(log.get("topics"), list) and log["topics"]
               and str(log["topics"][0]).lower() == event["topic0"].lower()
               and str(log.get("blockHash", "")).lower() == event["blockHash"].lower()
               and str(log.get("transactionHash", "")).lower() == event["transactionHash"].lower()
               and log.get("removed", False) is False]
    if len(matches) != 1:
        raise RpcError("RECEIPT_EVENT_NOT_RECONCILED")
    if "taskId" in event:
        data = byte_string(matches[0].get("data"))
        if len(data) < 32 or "0x" + data[:32].hex() != event["taskId"].lower():
            raise RpcError("RECEIPT_TASK_ID_MISMATCH")
    gas, price = quantity(receipt.get("gasUsed")), quantity(receipt.get("effectiveGasPrice"))
    if gas >= 2**256 or price >= 2**256:
        raise RpcError("INVALID_RECEIPT")
    result = {
        "transactionHash": event["transactionHash"],
        "blockHash": event["blockHash"],
        "matchedLogIndex": event["logIndex"],
        "receiptEventMatch": True,
        "executionGasCostBaseUnits": str(gas * price),
        "totalTransactionFee": "not_computed; L2 may have separate fee components",
    }
    if "l1Fee" in receipt:
        result["providerReportedL1FeeBaseUnits"] = str(quantity(receipt["l1Fee"]))
    return result


def run_probe(args: argparse.Namespace, transport: JsonRpcClient, source: dict, abi: list) -> dict:
    started = time.monotonic()
    client = DeadlineClient(transport, started + args.max_run_seconds, args.min_request_interval)
    report = {
        "schemaVersion": "1.0.0", "startedAtUtc": datetime.now(timezone.utc).isoformat(),
        "status": "incomplete", "endpointHost": transport.endpoint_host,
        "source": {"chainId": source["chainId"], "address": source["address"],
                   "reviewStatus": source["reviewStatus"], "abiSha256": source["selectedAbi"]["sha256"],
                   "upstreamCommit": source["upstream"]["commit"]},
        "limits": {"maxRequests": args.max_requests, "requestTimeoutSeconds": args.timeout,
                   "maxRunSeconds": args.max_run_seconds, "maxResponseBytes": 2_000_000,
                   "maxBlocks": 10_000, "initialChunk": args.chunk_size,
                   "minRequestStartIntervalSeconds": args.min_request_interval},
        "productionReadiness": "not_established", "feePlanEntitlement": "not_independently_verified",
        "warnings": ["Discovery only; a returned log range is not independently proven complete.",
                     "No full history, current proxy approval or cryptographic proof check is established.",
                     "Raw event data, taskResults, templates and request/response subjects are not retained in this report."],
    }
    try:
        chain_id = quantity(client.call("eth_chainId", []))
        report["observedChainId"] = chain_id
        if chain_id != 8453:
            raise RpcError("WRONG_CHAIN")
        head = quantity(client.call("eth_blockNumber", []))
        report["headBlock"] = head
        finalized = client.call("eth_getBlockByNumber", ["finalized", False])
        target = block_header(finalized)
        if target["number"] > head:
            raise RpcError("INVALID_FINALIZED_HEAD")
        report["providerReportedFinalized"] = target
        report["finalityPolicyReview"] = "pending; provider tag observed, L1 settlement policy not independently reviewed"
        end = args.to_block if args.to_block is not None else target["number"]
        if end > target["number"]:
            raise RpcError("RANGE_EXCEEDS_PROVIDER_FINALIZED")
        if end != target["number"]:
            target = block_header(client.call("eth_getBlockByNumber", [hex(end), False]))
            if target["number"] != end:
                raise RpcError("INVALID_BLOCK_HEADER")
        start = args.from_block if args.from_block is not None else max(0, end - args.lookback_blocks + 1)
        if start > end or end - start + 1 > 10_000:
            raise RpcError("BLOCK_RANGE_BUDGET_EXCEEDED")
        report["requestedRange"] = {"fromBlock": start, "toBlock": end, "targetHash": target["hash"]}
        code = byte_string(client.call("eth_getCode", [source["address"], hex(end)]))
        if not code:
            raise RpcError("NO_CONTRACT_CODE")
        report["runtimeCode"] = {"byteLength": len(code), "sha256": hashlib.sha256(code).hexdigest(),
                                 "sourceCompatibility": "unverified fingerprint; not a matched implementation"}
        slot = byte_string(client.call("eth_getStorageAt", [source["address"], EIP1967_IMPLEMENTATION, hex(end)]), 32)
        if any(slot[:12]):
            report["eip1967SlotObservation"] = {"state": "not_an_address_encoding"}
        elif any(slot[12:]):
            implementation = "0x" + slot[12:].hex()
            implementation_code = byte_string(client.call("eth_getCode", [implementation, hex(end)]))
            report["eip1967SlotObservation"] = {"candidateAddress": implementation,
                "candidateCodeBytes": len(implementation_code), "candidateCodeSha256": hashlib.sha256(implementation_code).hexdigest(),
                "approval": "not_verified; slot observation does not identify full proxy/admin history"}
        else:
            report["eip1967SlotObservation"] = {"state": "zero; proxy type not inferred"}

        topic_names = {e["topic0"].lower(): e["name"] for e in source["events"]}
        task_topics = [topic for topic, name in topic_names.items() if name in ("SubmitTask", "ReportResult", "CallbackFailed")]
        scope = hashlib.sha256(json.dumps([8453, source["address"].lower(), source["selectedAbi"]["sha256"],
                                            target["hash"], transport.endpoint_host]).encode()).hexdigest()
        checkpoint = args.output_dir / "checkpoints" / f"base-{start}-{end}-{scope[:16]}.json"
        scan = scan_logs(client, address=source["address"], topics=list(topic_names), task_topics=task_topics,
                         from_block=start, to_block=end, initial_chunk=args.chunk_size,
                         checkpoint_path=checkpoint, scope_id=scope)
        report["scan"] = scan
        report["scan"]["coverageMeaning"] = "successful bounded provider responses only; not independent completeness or full history"
        report["eventCounts"] = dict(Counter(topic_names[e["topic0"].lower()] for e in scan["events"]))
        report["checkpointPath"] = str(checkpoint)
        if not scan["complete"]:
            report["status"] = "partial"
            report["stopReason"] = scan["stopReason"]
            return report

        receipts = []
        seen_transactions: set[str] = set()
        for event in scan["events"]:
            tx = event["transactionHash"]
            if tx in seen_transactions:
                continue
            if len(receipts) >= args.receipt_limit:
                break
            receipts.append(receipt_projection(client.call("eth_getTransactionReceipt", [tx]), event))
            seen_transactions.add(tx)
        report["receiptSamples"] = receipts
        if args.receipt_limit == 0:
            report["warnings"].append("Receipt reconciliation skipped by explicit option.")
        task_ids = list(dict.fromkeys(e["taskId"] for e in scan["events"] if e.get("taskId")))
        if task_ids:
            task_id = task_ids[0]
            selector = next(r["selector"] for r in source["reads"] if r["name"] == "queryTask")
            result = client.call("eth_call", [{"to": source["address"], "data": selector + task_id[2:]}, hex(end)])
            report["taskStateSample"] = {"taskId": task_id, "asOfBlock": end,
                                        **project_task_state(result, abi, source)}
        else:
            report["taskStateSample"] = {"state": "not_run; no task ID observed in the bounded range"}
        # Reconcile the pinned boundary after the work, before claiming a stable sample.
        after = block_header(client.call("eth_getBlockByNumber", [hex(end), False]))
        if after["hash"] != target["hash"] or after["number"] != end:
            raise RpcError("TARGET_BLOCK_CHANGED")
        report["status"] = "bounded_sample_observed" if scan["events"] else "bounded_sample_empty"
        if not scan["events"]:
            report["warnings"].append("No matching events in this sample is not evidence of no Primus usage.")
        return report
    except RpcError as exc:
        report["status"] = "blocked" if not report.get("scan") else "partial"
        report["stopReason"] = exc.code
        if getattr(exc, "http_status", None) is not None:
            report["httpStatus"] = exc.http_status
        if getattr(exc, "retry_after_seconds", None) is not None:
            report["retryAfterSeconds"] = exc.retry_after_seconds
        return report
    finally:
        report["requestCount"] = transport.requests_made
        report["requestLedger"] = list(transport.events)
        report["elapsedSeconds"] = round(time.monotonic() - started, 3)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookback-blocks", type=int, default=1000)
    parser.add_argument("--from-block", type=int)
    parser.add_argument("--to-block", type=int)
    parser.add_argument("--chunk-size", type=int, default=100)
    parser.add_argument("--max-requests", type=int, default=40)
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--max-run-seconds", type=float, default=90)
    parser.add_argument("--receipt-limit", type=int, default=2)
    parser.add_argument("--min-request-interval", type=float, default=1)
    parser.add_argument("--output-dir", type=Path, default=REPO / ".local" / "discovery")
    args = parser.parse_args()
    if (not 1 <= args.lookback_blocks <= 10_000 or not 1 <= args.chunk_size <= 1000
            or not 1 <= args.max_requests <= 100 or not 0 < args.timeout <= 15
            or not args.timeout + 1 <= args.max_run_seconds <= 300
            or not 0 <= args.receipt_limit <= 3
            or not 0.5 <= args.min_request_interval <= 5
            or any(v is not None and v < 0 for v in (args.from_block, args.to_block))):
        parser.error("Discovery limits are out of bounds; inspect --help.")
    return args


def main() -> int:
    args = arguments()
    try:
        source, abi = source_manifest()
        transport = JsonRpcClient(os.environ.get("BASE_RPC_URL") or "https://mainnet.base.org",
                                  timeout_seconds=args.timeout, max_requests=args.max_requests)
        report = run_probe(args, transport, source, abi)
    except (OSError, ValueError, KeyError, StopIteration, RpcError):
        # Never include raw exceptions: an endpoint or unexpected source data can
        # contain secrets. Offline tests exercise detailed behavior separately.
        report = {"status": "blocked", "stopReason": "INVALID_LOCAL_CONFIGURATION", "requestCount": 0,
                  "productionReadiness": "not_established"}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    report_path = args.output_dir / f"base-rpc-{stamp}.json"
    atomic_json(report_path, report)
    print(json.dumps({"status": report["status"], "stopReason": report.get("stopReason"),
                      "requestCount": report["requestCount"], "reportPath": str(report_path)}))
    return {"bounded_sample_observed": 0, "bounded_sample_empty": 4, "partial": 3}.get(report["status"], 2)


if __name__ == "__main__":
    raise SystemExit(main())
