#!/usr/bin/env python3
"""Bounded BSC batch discovery: Etherscan source evidence + keyless RPC reads.

This helper does not index private wallet activity, decrypt values, prove source
completeness, or approve a public metric. No Etherscan credential is sent to RPC.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from datetime import datetime, timezone

from base_probe import DeadlineClient, EIP1967_IMPLEMENTATION, block_header, byte_string, quantity
from bsc_etherscan_probe import _event, reconcile_receipt
from etherscan_client import EtherscanError
from log_scan import _can_split, _error_code
from rpc_client import JsonRpcClient, RpcError


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=path.parent, encoding="utf-8", delete=False) as file:
            temporary = file.name
            json.dump(value, file, indent=2, sort_keys=True)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def load_evidence() -> dict:
    paths = [HERE / "sources" / "bsc-finance-source.json",
             REPO / "docs/discovery/bsc-first-source-observation.json",
             REPO / "docs/discovery/bsc-other-source-observations.json"]
    raw = [path.read_bytes() for path in paths]
    source, first, others = [json.loads(value) for value in raw]
    if source.get("chainId") != 56 or first.get("chainId") != 56 or others.get("chainId") != 56:
        raise RpcError("INVALID_SOURCE_EVIDENCE")
    approved = {route[key].lower() for route in source["routes"].values()
                for key in ("depositAggregator", "redeemAggregator")}
    candidates = {event["signature"]: event for event in source["candidateEvents"]}
    records = [{"address": first["contractAddress"], "implementationSource": first["implementationMetadata"],
                "events": first["matchedCandidateEvents"]}]
    records += [{"address": record["address"], "implementationSource": record["implementationSource"],
                 "events": record["matchedEvents"]} for record in others["contracts"]]
    contracts = {}
    for record in records:
        address = record["address"].lower()
        implementation = record["implementationSource"]["address"].lower()
        abi_hash = record["implementationSource"]["abiSha256"]
        if (address not in approved or not ADDRESS.fullmatch(address)
                or not ADDRESS.fullmatch(implementation) or int(implementation[2:], 16) == 0
                or not re.fullmatch(r"[0-9a-f]{64}", abi_hash) or address in contracts):
            raise RpcError("INVALID_SOURCE_EVIDENCE")
        event_map = {}
        for event in record["events"]:
            candidate = candidates.get(event.get("signature"))
            if (not candidate or event.get("name") != candidate["name"]
                    or event.get("topic0") != candidate["topic0"]
                    or not HASH.fullmatch(str(event.get("topic0", "")))
                    or type(event.get("topicCount")) is not int or not 1 <= event["topicCount"] <= 4
                    or type(event.get("dataWords")) is not int or not 0 <= event["dataWords"] <= 32):
                raise RpcError("INVALID_SOURCE_EVIDENCE")
            location = event.get("batchIdLocation")
            if location is not None and location not in ({"kind": "topic", "index": 1},
                                                        {"kind": "data_word", "index": 0}):
                raise RpcError("INVALID_SOURCE_EVIDENCE")
            if location and location["kind"] == "topic" and event["topicCount"] <= 1:
                raise RpcError("INVALID_SOURCE_EVIDENCE")
            if location and location["kind"] == "data_word" and event["dataWords"] < 1:
                raise RpcError("INVALID_SOURCE_EVIDENCE")
            event_map[event["topic0"].lower()] = {key: event[key] for key in
                ("name", "signature", "topic0", "topicCount", "dataWords", "batchIdLocation")}
        if not event_map:
            raise RpcError("INVALID_SOURCE_EVIDENCE")
        contracts[address] = {"expectedImplementation": implementation, "abiSha256": abi_hash,
                              "events": event_map}
    if set(contracts) != approved:
        raise RpcError("INVALID_SOURCE_EVIDENCE")
    hashes = {str(path.relative_to(REPO)): hashlib.sha256(value).hexdigest() for path, value in zip(paths, raw)}
    return {"chainId": 56, "contracts": contracts, "sourceFiles": hashes, "sourceDigest": digest(hashes)}


def _merge(events: list[dict], additions: list[dict]) -> list[dict]:
    unique, heights, positions = {}, {}, {}
    for event in events + additions:
        key = (event["blockHash"], event["transactionHash"], event["logIndex"])
        number, block = event["blockNumber"], event["blockHash"]
        position = (block, event["logIndex"])
        if ((number in heights and heights[number] != block)
                or (position in positions and positions[position] != event["transactionHash"])
                or (key in unique and unique[key] != event)):
            raise RpcError("INCONSISTENT_CANONICAL_EVENTS")
        unique[key], heights[number], positions[position] = event, block, event["transactionHash"]
    return sorted(unique.values(), key=lambda event: (event["blockNumber"], event["logIndex"], event["transactionHash"]))


def _project(raw: object, contracts: dict, low: int, high: int) -> dict:
    if not isinstance(raw, dict) or raw.get("removed") is not False:
        raise RpcError("INVALID_LOG_RESPONSE")
    address = str(raw.get("address", "")).lower()
    if address not in contracts:
        raise RpcError("UNAPPROVED_LOG_ADDRESS")
    _, event = _event(raw, address, contracts[address]["events"], low, high)
    if event is None or event["blockHash"] is None:
        raise RpcError("INVALID_LOG_RESPONSE")
    return event


def _restore(checkpoint: object, scope: dict, contracts: dict) -> tuple[list, list, int, str]:
    if not isinstance(checkpoint, dict) or checkpoint.get("schemaVersion") != 1:
        raise RpcError("CHECKPOINT_INVALID")
    if checkpoint.get("scope") != scope:
        raise RpcError("CHECKPOINT_SCOPE_MISMATCH")
    events, ranges, last, boundary = (checkpoint.get(key) for key in ("events", "ranges", "lastCompletedBlock", "boundaryHash"))
    if (not isinstance(events, list) or not isinstance(ranges, list) or type(last) is not int
            or not scope["fromBlock"] <= last <= scope["toBlock"]
            or not isinstance(boundary, str) or not HASH.fullmatch(boundary)):
        raise RpcError("CHECKPOINT_INVALID")
    expected = scope["fromBlock"]
    for item in ranges:
        if (not isinstance(item, dict) or set(item) != {"fromBlock", "toBlock", "eventCount"}
                or any(type(item[key]) is not int for key in item) or item["fromBlock"] != expected
                or item["toBlock"] < expected or item["toBlock"] > last or item["eventCount"] < 0):
            raise RpcError("CHECKPOINT_INVALID")
        expected = item["toBlock"] + 1
    if expected != last + 1:
        raise RpcError("CHECKPOINT_INVALID")
    for event in events:
        if not isinstance(event, dict):
            raise RpcError("CHECKPOINT_INVALID")
        address, topic = event.get("contractAddress"), event.get("topic0")
        descriptor = contracts.get(address, {}).get("events", {}).get(topic)
        required = {"chainId", "contractAddress", "blockNumber", "blockHash", "transactionHash", "logIndex", "topic0", "event", "finality"}
        if descriptor and descriptor["batchIdLocation"] is not None:
            required.add("batchId")
        if (not descriptor or set(event) != required or event["chainId"] != 56
                or type(event["blockNumber"]) is not int or not scope["fromBlock"] <= event["blockNumber"] <= last
                or type(event["logIndex"]) is not int or not 0 <= event["logIndex"] < 2**256
                or not HASH.fullmatch(str(event["blockHash"])) or not HASH.fullmatch(str(event["transactionHash"]))
                or event["event"] != descriptor["name"] or event["finality"] != "provider_observed_unreviewed"):
            raise RpcError("CHECKPOINT_INVALID")
        if "batchId" in event and (not isinstance(event["batchId"], str) or len(event["batchId"]) > 78
                                  or not DECIMAL.fullmatch(event["batchId"]) or int(event["batchId"]) >= 2**256):
            raise RpcError("CHECKPOINT_INVALID")
    merged = _merge([], events)
    if len(merged) != len(events):
        raise RpcError("CHECKPOINT_INVALID")
    for item in ranges:
        if item["eventCount"] != sum(item["fromBlock"] <= event["blockNumber"] <= item["toBlock"] for event in merged):
            raise RpcError("CHECKPOINT_INVALID")
    if any(event["blockNumber"] == last and event["blockHash"] != boundary for event in merged):
        raise RpcError("CHECKPOINT_INVALID")
    return ranges, merged, last, boundary.lower()


def scan_logs(client, evidence: dict, low: int, high: int, *, chunk_size: int = 10_000,
              max_logs: int = 500, checkpoint_path: Path | None = None, scope_id: str = "") -> dict:
    if (type(low) is not int or type(high) is not int or not 0 <= low <= high < 2**64
            or high - low + 1 > 100_000 or type(chunk_size) is not int or not 1 <= chunk_size <= 50_000
            or type(max_logs) is not int or not 1 <= max_logs <= 10_000):
        raise RpcError("INVALID_SCAN_LIMITS")
    contracts = evidence["contracts"]
    scope = {"id": scope_id, "chainId": 56, "sourceDigest": evidence["sourceDigest"],
             "fromBlock": low, "toBlock": high, "addresses": sorted(contracts)}
    ranges, events, last = [], [], None

    def result(reason=None):
        return {"ranges": ranges, "events": events, "lastCompletedBlock": last,
                "complete": reason is None and last == high, "stopReason": reason,
                "coverageMeaning": "successful bounded RPC responses; omissions and full history not independently proven"}

    if checkpoint_path is not None and checkpoint_path.exists():
        try:
            if checkpoint_path.stat().st_size > 10_000_000:
                raise RpcError("CHECKPOINT_INVALID")
            saved = json.loads(checkpoint_path.read_text())
            restored_ranges, restored_events, restored_last, boundary = _restore(saved, scope, contracts)
            header = block_header(client.call("eth_getBlockByNumber", [hex(restored_last), False]))
            if header["number"] != restored_last or header["hash"] != boundary:
                return result("CHECKPOINT_REORG")
            ranges, events, last = restored_ranges, restored_events, restored_last
        except (RpcError, EtherscanError) as error:
            return result(_error_code(error))
        except (ValueError, OSError, TypeError, KeyError):
            return result("CHECKPOINT_INVALID")
    cursor = low if last is None else last + 1
    chunk = chunk_size
    topics = sorted({topic for contract in contracts.values() for topic in contract["events"]})
    while cursor <= high:
        end = min(high, cursor + chunk - 1)
        try:
            raw = client.call("eth_getLogs", [{"address": sorted(contracts), "topics": [topics],
                "fromBlock": hex(cursor), "toBlock": hex(end)}])
        except Exception as error:
            if end > cursor and _can_split(error):
                chunk = max(1, (end - cursor + 1) // 2)
                continue
            return result(_error_code(error))
        if not isinstance(raw, list):
            return result("INVALID_LOG_RESPONSE")
        if len(raw) >= max_logs:
            if cursor == end:
                return result("SINGLE_BLOCK_LIMIT")
            chunk = max(1, (end - cursor + 1) // 2)
            continue
        try:
            additions = _merge([], [_project(item, contracts, cursor, end) for item in raw])
            updated = _merge(events, additions)
            header = block_header(client.call("eth_getBlockByNumber", [hex(end), False]))
            if header["number"] != end or any(event["blockNumber"] == end and event["blockHash"] != header["hash"] for event in additions):
                raise RpcError("BLOCK_HASH_MISMATCH")
            next_ranges = ranges + [{"fromBlock": cursor, "toBlock": end, "eventCount": len(additions)}]
            if checkpoint_path is not None:
                atomic_json(checkpoint_path, {"schemaVersion": 1, "scope": scope, "ranges": next_ranges,
                    "events": updated, "lastCompletedBlock": end, "boundaryHash": header["hash"]})
        except (RpcError, EtherscanError) as error:
            return result(_error_code(error))
        except OSError:
            return result("CHECKPOINT_WRITE_FAILED")
        ranges, events, last = next_ranges, updated, end
        cursor, chunk = end + 1, min(chunk_size, chunk * 2)
    return result()


def run_probe(args, transport: JsonRpcClient, evidence: dict) -> dict:
    started = time.monotonic()
    client = DeadlineClient(transport, started + args.max_run_seconds, args.min_request_interval)
    report = {"schemaVersion": "1.0.0", "startedAtUtc": datetime.now(timezone.utc).isoformat(),
              "chainIdExpected": 56, "endpointHost": transport.endpoint_host, "status": "incomplete",
              "sourceFiles": evidence["sourceFiles"], "productionReadiness": "not_established",
              "warnings": ["Provider-reported finalized is not an independent finality proof.",
                  "Current explorer ABI evidence does not establish historical implementation validity.",
                  "No raw amounts, exchange rates, participant addresses or private wallet data are retained."],
              "limits": {"maxRequests": args.max_requests, "timeoutSeconds": args.timeout,
                  "maxRunSeconds": args.max_run_seconds, "minRequestIntervalSeconds": args.min_request_interval,
                  "chunkSize": args.chunk_size, "maxLookbackBlocks": 100_000}}
    try:
        observed = quantity(client.call("eth_chainId", []))
        report["observedChainId"] = observed
        if observed != 56:
            raise RpcError("WRONG_CHAIN")
        target = block_header(client.call("eth_getBlockByNumber", ["finalized", False]))
        report["providerReportedFinalized"] = target
        end = args.to_block if args.to_block is not None else target["number"]
        if end > target["number"]:
            raise RpcError("RANGE_EXCEEDS_PROVIDER_FINALIZED")
        if end != target["number"]:
            target = block_header(client.call("eth_getBlockByNumber", [hex(end), False]))
        if target["number"] != end:
            raise RpcError("INVALID_BLOCK_HEADER")
        low = args.from_block if args.from_block is not None else max(0, end - args.lookback_blocks + 1)
        if low > end or end - low + 1 > 100_000:
            raise RpcError("BLOCK_RANGE_BUDGET_EXCEEDED")
        report["requestedRange"] = {"fromBlock": low, "toBlock": end, "targetHash": target["hash"]}
        checks, implementation_codes = [], {}
        for address, contract in evidence["contracts"].items():
            code = byte_string(client.call("eth_getCode", [address, hex(end)]))
            if not code:
                raise RpcError("NO_CONTRACT_CODE")
            slot = byte_string(client.call("eth_getStorageAt", [address, EIP1967_IMPLEMENTATION, hex(end)]), 32)
            if any(slot[:12]):
                raise RpcError("INVALID_IMPLEMENTATION_SLOT")
            implementation = "0x" + slot[12:].hex()
            if implementation != contract["expectedImplementation"]:
                raise RpcError("IMPLEMENTATION_SOURCE_MISMATCH")
            if implementation not in implementation_codes:
                implementation_code = byte_string(client.call("eth_getCode", [implementation, hex(end)]))
                if not implementation_code:
                    raise RpcError("NO_IMPLEMENTATION_CODE")
                implementation_codes[implementation] = hashlib.sha256(implementation_code).hexdigest()
            checks.append({"address": address, "runtimeCodeSha256": hashlib.sha256(code).hexdigest(),
                "observedImplementation": implementation, "implementationMatchesSource": True,
                "implementationCodeSha256": implementation_codes[implementation], "abiSha256": contract["abiSha256"]})
        report["contractChecks"] = checks
        scope_id = digest([evidence["sourceDigest"], target["hash"], transport.endpoint_host])
        checkpoint = args.output_dir / "checkpoints" / f"bsc-{low}-{end}-{scope_id[:16]}.json"
        scan = scan_logs(client, evidence, low, end, chunk_size=args.chunk_size,
                         checkpoint_path=checkpoint, scope_id=scope_id)
        report["scan"], report["checkpointPath"] = scan, str(checkpoint)
        if not scan["complete"]:
            report["status"], report["stopReason"] = "partial", scan["stopReason"]
            return report
        receipts, transactions = [], set()
        for event in scan["events"]:
            if len(receipts) >= args.receipt_limit:
                break
            if event["transactionHash"] in transactions:
                continue
            raw = client.call("eth_getTransactionReceipt", [event["transactionHash"]])
            descriptor = evidence["contracts"][event["contractAddress"]]["events"][event["topic0"]]
            receipts.append(reconcile_receipt(raw, event, descriptor))
            transactions.add(event["transactionHash"])
        report["receiptSamples"] = receipts
        if args.receipt_limit == 0:
            report["warnings"].append("Receipt reconciliation skipped by explicit option.")
        after = block_header(client.call("eth_getBlockByNumber", [hex(end), False]))
        if after["number"] != end or after["hash"] != target["hash"]:
            raise RpcError("TARGET_BLOCK_CHANGED")
        report["status"] = "bounded_batch_sample_observed" if scan["events"] else "bounded_sample_empty"
        if not scan["events"]:
            report["warnings"].append("No matching events in this scope is not proof of no Primus usage.")
        return report
    except (RpcError, EtherscanError) as error:
        report["status"] = "partial" if "scan" in report else "blocked"
        report["stopReason"] = _error_code(error)
        return report
    finally:
        report["requestCount"], report["requestLedger"] = transport.requests_made, list(transport.events)
        report["elapsedSeconds"] = round(time.monotonic() - started, 3)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookback-blocks", type=int, default=50_000)
    parser.add_argument("--from-block", type=int)
    parser.add_argument("--to-block", type=int)
    parser.add_argument("--chunk-size", type=int, default=10_000)
    parser.add_argument("--max-requests", type=int, default=60)
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--max-run-seconds", type=float, default=120)
    parser.add_argument("--min-request-interval", type=float, default=1)
    parser.add_argument("--receipt-limit", type=int, default=2)
    parser.add_argument("--output-dir", type=Path, default=REPO / ".local/discovery")
    args = parser.parse_args(argv)
    if (not 1 <= args.lookback_blocks <= 100_000 or not 1 <= args.chunk_size <= 50_000
            or not 1 <= args.max_requests <= 80 or not 0 < args.timeout <= 15
            or not args.timeout + 1 <= args.max_run_seconds <= 300
            or not 0.5 <= args.min_request_interval <= 5 or not 0 <= args.receipt_limit <= 3
            or any(value is not None and not 0 <= value < 2**64 for value in (args.from_block, args.to_block))):
        parser.error("Discovery limits are out of bounds.")
    return args


def main(argv=None):
    args = arguments(argv)
    try:
        evidence = load_evidence()
        transport = JsonRpcClient(os.environ.get("BNB_RPC_URL") or "https://bsc-rpc.publicnode.com",
                                  timeout_seconds=args.timeout, max_requests=args.max_requests)
        report = run_probe(args, transport, evidence)
    except (OSError, ValueError, KeyError, TypeError, RpcError, EtherscanError):
        report = {"status": "blocked", "stopReason": "INVALID_LOCAL_CONFIGURATION",
                  "requestCount": 0, "productionReadiness": "not_established"}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = args.output_dir / f"bsc-rpc-{stamp}.json"
    atomic_json(path, report)
    print(json.dumps({"status": report["status"], "stopReason": report.get("stopReason"),
                      "requestCount": report["requestCount"], "reportPath": str(path)}))
    return {"bounded_batch_sample_observed": 0, "bounded_sample_empty": 4, "partial": 3}.get(report["status"], 2)


if __name__ == "__main__":
    raise SystemExit(main())
