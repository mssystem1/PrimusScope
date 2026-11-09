#!/usr/bin/env python3
"""Bounded BSC Confidential Finance discovery using Etherscan V2.

Metadata-only unless an explicit bounded block interval is supplied. This is
not an indexer, a decryption service, or approval to publish finance metrics.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time
from datetime import datetime, timezone

from etherscan_client import EtherscanClient, EtherscanError


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEX = re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")
QUANTITY = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")


def load_source() -> dict:
    source = json.loads((HERE / "sources" / "bsc-finance-source.json").read_text())
    if source.get("chainId") != 56 or source.get("explorerApi", {}).get("chainIdParameter") != "56":
        raise EtherscanError("INVALID_SOURCE_REGISTRY")
    for route in source["routes"].values():
        for key in ("depositAggregator", "redeemAggregator"):
            if not ADDRESS.fullmatch(str(route[key])):
                raise EtherscanError("INVALID_SOURCE_REGISTRY")
    return source


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _quantity(value: object) -> int:
    if not isinstance(value, str) or len(value) > 78:
        raise EtherscanError("INVALID_LOG_RESPONSE")
    if QUANTITY.fullmatch(value) and len(value) <= 66:
        return int(value, 16)
    if DECIMAL.fullmatch(value):
        number = int(value)
        if number < 2**256:
            return number
    raise EtherscanError("INVALID_LOG_RESPONSE")


def _hash(value: object) -> str:
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise EtherscanError("INVALID_LOG_RESPONSE")
    return value.lower()


def _abi(entry: dict, client: EtherscanClient, address: str) -> list:
    if not isinstance(entry.get("SourceCode"), str) or not entry["SourceCode"].strip():
        raise EtherscanError("UNVERIFIED_CONTRACT")
    raw = entry.get("ABI")
    try:
        abi = json.loads(raw) if isinstance(raw, str) else None
    except (ValueError, RecursionError):
        abi = None
    if not isinstance(abi, list) or any(not isinstance(item, dict) for item in abi):
        abi = client.get_abi(address)
    if not isinstance(abi, list) or any(not isinstance(item, dict) for item in abi):
        raise EtherscanError("INVALID_ABI_RESPONSE")
    return abi


def _metadata(entry: dict, address: str, abi: list) -> dict:
    name = entry.get("ContractName")
    safe_name = name if isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.$:-]{1,120}", name) else None
    return {
        "address": address.lower(), "reportedContractName": safe_name,
        "sourceCodeSha256": hashlib.sha256(entry["SourceCode"].encode()).hexdigest(),
        "abiSha256": digest(abi), "abiEntryCount": len(abi),
        "evidence": "explorer_verified_source_metadata; deployed bytecode not independently checked",
    }


def matching_events(abi: list, source: dict) -> dict[str, dict]:
    """Only source-candidate signatures actually present in the returned ABI."""
    candidates = {item["signature"]: item for item in source["candidateEvents"]}
    matched = {}
    for entry in abi:
        if entry.get("type") != "event" or entry.get("anonymous", False) is not False:
            continue
        inputs = entry.get("inputs")
        if not isinstance(inputs, list) or not all(isinstance(item, dict) for item in inputs):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not all(isinstance(item.get("type"), str) for item in inputs):
            continue
        signature = name + "(" + ",".join(item["type"] for item in inputs) + ")"
        if signature not in candidates or any(type(item.get("indexed")) is not bool for item in inputs):
            continue
        candidate = candidates[signature]
        topic = _hash(candidate["topic0"])
        location = None
        if (inputs and inputs[0].get("type") == "uint256"
                and str(inputs[0].get("name", "")).lower() in {"aggregateid", "batchid"}):
            location = {"kind": "topic", "index": 1} if inputs[0]["indexed"] else {"kind": "data_word", "index": 0}
        descriptor = {
            "name": name, "signature": signature, "topic0": topic,
            "batchIdLocation": location,
            "topicCount": 1 + sum(item["indexed"] for item in inputs),
            "dataWords": sum(not item["indexed"] for item in inputs),
        }
        if topic in matched and matched[topic] != descriptor:
            raise EtherscanError("CONFLICTING_EVENT_ABI")
        matched[topic] = descriptor
    return matched


def _event(raw: object, address: str, event_map: dict, low: int, high: int) -> tuple[tuple, dict | None]:
    if not isinstance(raw, dict) or raw.get("removed", False) is not False:
        raise EtherscanError("INVALID_LOG_RESPONSE")
    if not ADDRESS.fullmatch(str(raw.get("address", ""))) or raw["address"].lower() != address.lower():
        raise EtherscanError("INVALID_LOG_RESPONSE")
    block, index = _quantity(raw.get("blockNumber")), _quantity(raw.get("logIndex"))
    if not low <= block <= high:
        raise EtherscanError("LOG_OUTSIDE_REQUESTED_RANGE")
    transaction = _hash(raw.get("transactionHash"))
    topics = raw.get("topics")
    if not isinstance(topics, list) or not topics or len(topics) > 4:
        raise EtherscanError("INVALID_LOG_RESPONSE")
    topics = [_hash(item) for item in topics]
    block_hash = None if raw.get("blockHash") is None else _hash(raw["blockHash"])
    identity = (transaction, index)
    descriptor = event_map.get(topics[0])
    if descriptor is None:
        return identity, None
    data = raw.get("data")
    if (not isinstance(data, str) or not HEX.fullmatch(data)
            or len(topics) != descriptor["topicCount"]
            or len(data[2:]) != descriptor["dataWords"] * 64):
        raise EtherscanError("INVALID_EVENT_ENCODING")
    projected = {
        "chainId": 56, "contractAddress": address.lower(), "blockNumber": block,
        "blockHash": block_hash, "transactionHash": transaction, "logIndex": index,
        "topic0": topics[0], "event": descriptor["name"],
        "finality": "provider_observed_unreviewed",
    }
    location = descriptor["batchIdLocation"]
    if location:
        word = topics[location["index"]] if location["kind"] == "topic" else "0x" + data[2:66]
        projected["batchId"] = str(int(word, 16))
    return identity, projected


def scan_events(client: EtherscanClient, address: str, event_map: dict, from_block: int,
                to_block: int, page_size: int = 1000, max_pages: int = 3) -> dict:
    """Bounded pagination; a provider short page is not independent completeness."""
    report = {"events": [], "pagesFetched": 0, "complete": False, "stopReason": None,
              "coverageMeaning": "bounded provider pages only; omissions/finality not independently proven"}
    seen = set()
    fingerprints = set()
    block_hashes = {}
    transaction_blocks = {}
    try:
        for page in range(1, max_pages + 1):
            rows = client.get_logs(address, from_block, to_block, page=page, offset=page_size)
            report["pagesFetched"] += 1
            if not isinstance(rows, list) or len(rows) > page_size:
                raise EtherscanError("INVALID_LOG_RESPONSE")
            normalized = [_event(row, address, event_map, from_block, to_block) for row in rows]
            keys = [key for key, _ in normalized]
            fingerprint = tuple(sorted(keys))
            if keys and fingerprint in fingerprints:
                raise EtherscanError("REPEATED_PAGE")
            if len(set(keys)) != len(keys) or any(key in seen for key in keys):
                raise EtherscanError("DUPLICATE_EVENT")
            next_blocks = dict(block_hashes)
            next_transactions = dict(transaction_blocks)
            for row in rows:
                number, transaction = _quantity(row["blockNumber"]), _hash(row["transactionHash"])
                block_hash = None if row.get("blockHash") is None else _hash(row["blockHash"])
                if block_hash is not None:
                    if number in next_blocks and next_blocks[number] != block_hash:
                        raise EtherscanError("CONFLICTING_BLOCK_HASH")
                    next_blocks[number] = block_hash
                if transaction in next_transactions and next_transactions[transaction][0] != number:
                    raise EtherscanError("CONFLICTING_TRANSACTION_BLOCK")
                next_transactions[transaction] = (number, block_hash)
            fingerprints.add(fingerprint)
            seen.update(keys)
            block_hashes, transaction_blocks = next_blocks, next_transactions
            report["events"].extend(event for _, event in normalized if event is not None)
            if len(rows) < page_size:
                report["complete"] = True
                break
        if not report["complete"]:
            report["stopReason"] = "PAGE_BUDGET_EXHAUSTED"
    except EtherscanError as error:
        report["stopReason"] = error.code
    report["events"].sort(key=lambda item: (item["blockNumber"], item["logIndex"], item["transactionHash"]))
    return report


def reconcile_receipt(receipt: object, event: dict, descriptor: dict) -> dict:
    if not isinstance(receipt, dict) or not isinstance(receipt.get("logs"), list):
        raise EtherscanError("RECEIPT_NOT_AVAILABLE")
    if (str(receipt.get("transactionHash", "")).lower() != event["transactionHash"]
            or _quantity(receipt.get("blockNumber")) != event["blockNumber"]
            or _quantity(receipt.get("status")) != 1):
        raise EtherscanError("RECEIPT_EVENT_MISMATCH")
    block_hash = _hash(receipt.get("blockHash"))
    if event["blockHash"] is not None and block_hash != event["blockHash"]:
        raise EtherscanError("RECEIPT_BLOCK_HASH_MISMATCH")
    matches = []
    for raw in receipt["logs"]:
        if not isinstance(raw, dict) or str(raw.get("address", "")).lower() != event["contractAddress"]:
            continue
        if _quantity(raw.get("logIndex")) != event["logIndex"]:
            continue
        _, projected = _event(raw, event["contractAddress"], {event["topic0"]: descriptor},
                              event["blockNumber"], event["blockNumber"])
        if (projected is None or projected["transactionHash"] != event["transactionHash"]
                or projected.get("batchId") != event.get("batchId")
                or (projected["blockHash"] is not None and projected["blockHash"] != block_hash)):
            raise EtherscanError("RECEIPT_EVENT_MISMATCH")
        matches.append(projected)
    if len(matches) != 1:
        raise EtherscanError("RECEIPT_EVENT_MISMATCH")
    return {"transactionHash": event["transactionHash"], "logIndex": event["logIndex"],
            "blockHash": block_hash, "batchId": event.get("batchId"), "receiptEventMatch": True,
            "finality": "provider_observed_unreviewed"}


def run_probe(args: argparse.Namespace, client: EtherscanClient, source: dict) -> dict:
    started = time.monotonic()
    route = source["routes"][args.route]
    address = route["depositAggregator" if args.role == "deposit" else "redeemAggregator"]
    report = {
        "schemaVersion": "1.0.0", "startedAtUtc": datetime.now(timezone.utc).isoformat(),
        "status": "incomplete", "chainId": 56, "provider": "Etherscan V2",
        "route": route["id"], "role": args.role, "contractAddress": address.lower(),
        "sourceReviewStatus": source["reviewStatus"],
        "sourceConfigurationSha256": source["source"]["configurationSha256"],
        "productionReadiness": "not_established", "publicationReview": "not_approved",
        "nativeBatchState": "not_queried", "apy": "not_queried",
        "limits": {"maxRequests": args.max_requests, "timeoutSeconds": args.timeout,
                   "minRequestIntervalSeconds": args.min_request_interval,
                   "pageSize": args.page_size, "maxPages": args.max_pages, "maxBlocks": 10_000},
        "warnings": ["Official frontend config is not deployed-code or ABI-version approval.",
                     "No user amounts, participants, permits, private positions or full event payloads are retained.",
                     "An observed batch finalization is not proof every participant claimed.",
                     "Native state, privacy/publication policy, finality and APY history need separate validation."],
    }
    try:
        if source.get("chainId") != 56:
            raise EtherscanError("INVALID_SOURCE_REGISTRY")
        entries = client.get_source(address)
        if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
            raise EtherscanError("INVALID_METADATA_RESPONSE")
        entry = entries[0]
        abi = _abi(entry, client, address)
        report["contractMetadata"] = _metadata(entry, address, abi)
        if entry.get("Proxy") == "1":
            implementation = entry.get("Implementation")
            if (not isinstance(implementation, str) or not ADDRESS.fullmatch(implementation)
                    or implementation.lower() in {address.lower(), "0x" + "0" * 40}):
                raise EtherscanError("PROXY_IMPLEMENTATION_UNRESOLVED")
            entries = client.get_source(implementation)
            if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
                raise EtherscanError("INVALID_METADATA_RESPONSE")
            entry = entries[0]
            if entry.get("Proxy") == "1":
                raise EtherscanError("NESTED_PROXY_UNRESOLVED")
            abi = _abi(entry, client, implementation)
            report["implementationMetadata"] = _metadata(entry, implementation, abi)
        elif entry.get("Proxy") != "0":
            report["warnings"].append("Explorer proxy classification unavailable; no implementation inference made.")
        event_map = matching_events(abi, source)
        report["matchedCandidateEvents"] = list(event_map.values())
        report["abiVersionHistory"] = "unverified; current explorer ABI may not describe historical logs"
        if args.from_block is None:
            report["status"] = "metadata_observed_logs_not_requested"
            report["batchEventCount"] = None
            return report
        report["requestedRange"] = {"fromBlock": args.from_block, "toBlock": args.to_block}
        if not event_map:
            raise EtherscanError("BATCH_EVENT_ABI_UNRESOLVED")
        scan = scan_events(client, address, event_map, args.from_block, args.to_block,
                           args.page_size, args.max_pages)
        report["scan"] = scan
        report["batchEventCount"] = len(scan["events"]) if scan["complete"] else None
        if not scan["complete"]:
            report["status"] = "partial"
            report["stopReason"] = scan["stopReason"]
            return report
        if scan["events"] and args.receipt_sample:
            event = scan["events"][0]
            report["receiptSample"] = reconcile_receipt(client.get_receipt(event["transactionHash"]),
                                                        event, event_map[event["topic0"]])
        elif not args.receipt_sample:
            report["warnings"].append("Receipt reconciliation skipped by explicit option.")
        report["status"] = "bounded_batch_sample_observed" if scan["events"] else "bounded_sample_empty"
        if not scan["events"]:
            report["warnings"].append("No matching batch events in this interval does not establish no product usage.")
        return report
    except EtherscanError as error:
        report["status"] = "partial" if "scan" in report else "blocked"
        report["stopReason"] = error.code
        return report
    finally:
        report["requestCount"] = client.requests_made
        report["requestLedger"] = list(client.events)
        report["elapsedSeconds"] = round(time.monotonic() - started, 3)


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--route", choices=("u", "usdt"), default="u")
    parser.add_argument("--role", choices=("deposit", "redeem"), default="deposit")
    parser.add_argument("--from-block", type=int)
    parser.add_argument("--to-block", type=int)
    parser.add_argument("--page-size", type=int, default=1000)
    parser.add_argument("--max-pages", type=int, default=3)
    parser.add_argument("--max-requests", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--min-request-interval", type=float, default=1)
    parser.add_argument("--receipt-sample", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--output-dir", type=Path, default=REPO / ".local" / "discovery")
    args = parser.parse_args(argv)
    if ((args.from_block is None) != (args.to_block is None)
            or (args.from_block is not None and not 0 <= args.from_block <= args.to_block < 2**64)
            or (args.from_block is not None and args.to_block - args.from_block + 1 > 10_000)
            or not 1 <= args.page_size <= 1000 or not 1 <= args.max_pages <= 5
            or not 1 <= args.max_requests <= 20 or not 0 < args.timeout <= 15
            or not 0.5 <= args.min_request_interval <= 5):
        parser.error("Discovery limits are out of bounds; supply both block bounds or neither.")
    return args


def main(argv: list[str] | None = None) -> int:
    args = arguments(argv)
    try:
        source = load_source()
        client = EtherscanClient(os.environ.get("ETHERSCAN_API_KEY", ""), timeout_seconds=args.timeout,
                                 max_requests=args.max_requests, min_interval_seconds=args.min_request_interval)
        report = run_probe(args, client, source)
    except EtherscanError as error:
        report = {"schemaVersion": "1.0.0", "status": "blocked", "chainId": 56,
                  "provider": "Etherscan V2", "stopReason": error.code,
                  "requestCount": 0, "productionReadiness": "not_established"}
    except (OSError, ValueError, KeyError, TypeError):
        report = {"schemaVersion": "1.0.0", "status": "blocked", "chainId": 56,
                  "stopReason": "LOCAL_SOURCE_CONFIGURATION_ERROR", "requestCount": 0,
                  "productionReadiness": "not_established"}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = args.output_dir / f"bsc-etherscan-{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)
    print(json.dumps({"status": report["status"], "chainId": 56, "stopReason": report.get("stopReason"),
                      "requestCount": report["requestCount"], "reportPath": str(path)}))
    return {"metadata_observed_logs_not_requested": 0, "bounded_batch_sample_observed": 0,
            "partial": 3, "bounded_sample_empty": 4}.get(report["status"], 2)


if __name__ == "__main__":
    raise SystemExit(main())
