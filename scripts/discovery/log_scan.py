"""Bounded discovery scans, not a production indexer or completeness proof.

Only approved event metadata is returned or checkpointed. ``complete`` means the
requested ranges returned and validated; it cannot certify an RPC's omissions.
The caller must scope checkpoints to the chain, ABI and pinned target block.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any


_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
_HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
_QUANTITY = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
_DATA = re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")
_SAFE_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,79}\Z")


class _Invalid(ValueError):
    pass


def _hex(value: Any, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise _Invalid()
    return value.lower()


def _integer(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise _Invalid()
    return value


def _quantity(value: Any) -> int:
    if not isinstance(value, str) or len(value) > 66:
        raise _Invalid()
    return int(_hex(value, _QUANTITY), 16)


def _error_code(error: Exception) -> str:
    code = getattr(error, "code", None)
    if isinstance(code, str) and _SAFE_CODE.fullmatch(code):
        return code
    return "TIMEOUT" if isinstance(error, TimeoutError) else "RPC_ERROR"


def _can_split(error: Exception) -> bool:
    code = _error_code(error)
    if any(word in code for word in ("BUDGET", "RATE", "429", "DENIED", "FORBIDDEN", "AUTH")):
        return False
    if code in {
        "TIMEOUT", "RPC_TIMEOUT", "REQUEST_TIMEOUT", "DEADLINE_EXCEEDED",
        "RESPONSE_TOO_LARGE", "RANGE_TOO_LARGE", "LOG_RANGE_LIMIT", "RPC_RANGE_LIMIT",
    }:
        return True
    # Inspect error text only for diagnosis; never return or persist it. RPC
    # -32005 can mean rate limiting too, so the number alone is insufficient.
    message = str(error).lower()
    return any(fragment in message for fragment in (
        "block range", "range too wide", "range too large", "too many results",
        "too many logs", "query returned more than", "response too large",
        "response size exceeded", "log response size exceeded",
    ))


def _sanitize(raw: Any, scope: dict, low: int, high: int) -> dict:
    if not isinstance(raw, dict) or raw.get("removed") is not False:
        raise _Invalid()
    address = _hex(raw.get("address"), _ADDRESS)
    number = _quantity(raw.get("blockNumber"))
    topics = raw.get("topics")
    if (
        address != scope["address"] or not low <= number <= high
        or not isinstance(topics, list) or not topics
    ):
        raise _Invalid()
    topic0 = [_hex(topic, _HASH) for topic in topics][0]
    if topic0 not in scope["topics"]:
        raise _Invalid()
    event = {
        "address": address,
        "blockNumber": number,
        "blockHash": _hex(raw.get("blockHash"), _HASH),
        "transactionHash": _hex(raw.get("transactionHash"), _HASH),
        "logIndex": _quantity(raw.get("logIndex")),
        "topic0": topic0,
    }
    if topic0 in scope["taskTopics"]:
        data = _hex(raw.get("data"), _DATA)
        if len(data) < 66:
            raise _Invalid()
        event["taskId"] = data[:66]
    return event


def _merge(events: list[dict], additions: list[dict]) -> list[dict]:
    unique: dict[tuple, dict] = {}
    blocks: dict[int, str] = {}
    positions: dict[tuple, str] = {}
    for event in events + additions:
        number, block = event["blockNumber"], event["blockHash"]
        key = (block, event["transactionHash"], event["logIndex"])
        position = (block, event["logIndex"])
        if (
            (number in blocks and blocks[number] != block)
            or (key in unique and unique[key] != event)
            or (position in positions and positions[position] != event["transactionHash"])
        ):
            raise _Invalid()
        blocks[number] = block
        positions[position] = event["transactionHash"]
        unique[key] = event
    return sorted(unique.values(), key=lambda e: (
        e["blockNumber"], e["logIndex"], e["transactionHash"],
    ))


def _block_hash(client: Any, number: int) -> str:
    header = client.call("eth_getBlockByNumber", [hex(number), False])
    if not isinstance(header, dict) or _quantity(header.get("number")) != number:
        raise _Invalid()
    return _hex(header.get("hash"), _HASH)


def _restore(saved: Any, scope: dict) -> tuple[list, list, int | None, str | None]:
    if not isinstance(saved, dict) or saved.get("schemaVersion") != 1:
        raise _Invalid()
    if saved.get("scope") != scope:
        raise _Invalid("CHECKPOINT_SCOPE_MISMATCH")
    ranges, stored = saved.get("ranges"), saved.get("events")
    if not isinstance(ranges, list) or not isinstance(stored, list):
        raise _Invalid()
    last = saved.get("lastCompletedBlock")
    boundary = saved.get("boundaryHash")
    if last is None:
        if ranges or stored or boundary is not None:
            raise _Invalid()
        return [], [], None, None
    last = _integer(last)
    boundary = _hex(boundary, _HASH)
    if not scope["fromBlock"] <= last <= scope["toBlock"]:
        raise _Invalid()
    expected = scope["fromBlock"]
    for item in ranges:
        if not isinstance(item, dict) or set(item) != {"fromBlock", "toBlock", "eventCount"}:
            raise _Invalid()
        low, high = _integer(item["fromBlock"]), _integer(item["toBlock"])
        _integer(item["eventCount"])
        if low != expected or high < low or high > last:
            raise _Invalid()
        expected = high + 1
    if expected != last + 1:
        raise _Invalid()
    events = []
    for item in stored:
        if not isinstance(item, dict):
            raise _Invalid()
        allowed = {"address", "blockNumber", "blockHash", "transactionHash", "logIndex", "topic0"}
        if item.get("topic0") in scope["taskTopics"]:
            allowed.add("taskId")
        if set(item) != allowed:
            raise _Invalid()
        raw = dict(item, removed=False, topics=[item["topic0"]])
        raw["blockNumber"] = hex(_integer(item["blockNumber"]))
        raw["logIndex"] = hex(_integer(item["logIndex"]))
        raw["data"] = item.get("taskId")
        events.append(_sanitize(raw, scope, scope["fromBlock"], last))
    merged = _merge([], events)
    if len(merged) != len(events):
        raise _Invalid()
    for item in ranges:
        if item["eventCount"] != sum(
            item["fromBlock"] <= event["blockNumber"] <= item["toBlock"] for event in merged
        ):
            raise _Invalid()
    if any(e["blockNumber"] == last and e["blockHash"] != boundary for e in merged):
        raise _Invalid()
    return ranges, merged, last, boundary


def _save(path: Path, scope: dict, ranges: list, events: list, last: int, boundary: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as file:
            temporary = file.name
            json.dump({
                "schemaVersion": 1, "scope": scope, "ranges": ranges, "events": events,
                "lastCompletedBlock": last, "boundaryHash": boundary,
            }, file, sort_keys=True, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def scan_logs(
    client: Any, *, address: str, topics: list[str], from_block: int, to_block: int,
    initial_chunk: int = 100, max_logs_per_response: int = 250,
    checkpoint_path: Path | None = None, scope_id: str = "",
    task_topics: list[str] | None = None,
) -> dict:
    """Scan a bounded range without skipping gaps or trusting capped responses.

    Explicit ``task_topics`` identify events whose first nonindexed ABI word is
    a bytes32 task ID. All other data words and additional topics are discarded.
    Client-side request/time budgets remain the caller's responsibility. There
    are no scanner retries except smaller-range probes after known size/time
    failures. Existing checkpoints are never overwritten after invalid resume.
    """
    _integer(from_block)
    _integer(to_block)
    if from_block > to_block or _integer(initial_chunk) < 1 or _integer(max_logs_per_response) < 1:
        raise ValueError("Invalid bounded scan limits")
    if not isinstance(topics, list) or not topics or not isinstance(scope_id, str):
        raise ValueError("A source scope and nonempty topic list are required")
    if task_topics is not None and not isinstance(task_topics, list):
        raise ValueError("task_topics must be a list")
    scope = {
        "id": scope_id, "address": _hex(address, _ADDRESS),
        "topics": sorted(set(_hex(topic, _HASH) for topic in topics)),
        "taskTopics": sorted(set(_hex(topic, _HASH) for topic in (task_topics or []))),
        "fromBlock": from_block, "toBlock": to_block,
    }
    if not set(scope["taskTopics"]).issubset(scope["topics"]):
        raise ValueError("Task topics must be in the approved scan topics")
    ranges: list[dict] = []
    events: list[dict] = []
    last: int | None = None

    def result(reason: str | None = None) -> dict:
        return {
            "ranges": ranges, "events": events, "lastCompletedBlock": last,
            "complete": reason is None and last == to_block, "stopReason": reason,
        }

    if checkpoint_path is not None:
        checkpoint_path = Path(checkpoint_path)
        try:
            if checkpoint_path.exists():
                saved = json.loads(checkpoint_path.read_text(encoding="utf-8"))
                restored_ranges, restored_events, restored_last, boundary = _restore(saved, scope)
                if restored_last is not None and _block_hash(client, restored_last) != boundary:
                    return result("CHECKPOINT_REORG")
                ranges, events, last = restored_ranges, restored_events, restored_last
        except _Invalid as error:
            return result("CHECKPOINT_SCOPE_MISMATCH" if str(error) == "CHECKPOINT_SCOPE_MISMATCH" else "CHECKPOINT_INVALID")
        except (OSError, ValueError, TypeError):
            return result("CHECKPOINT_INVALID")
        except Exception as error:
            return result(_error_code(error))

    low = from_block if last is None else last + 1
    chunk = initial_chunk
    while low <= to_block:
        high = min(low + chunk - 1, to_block)
        try:
            raw = client.call("eth_getLogs", [{
                "address": scope["address"], "topics": [scope["topics"]],
                "fromBlock": hex(low), "toBlock": hex(high),
            }])
        except Exception as error:
            if high > low and _can_split(error):
                chunk = max(1, (high - low + 1) // 2)
                continue
            return result(_error_code(error))
        if not isinstance(raw, list):
            return result("INVALID_LOG_RESPONSE")
        if len(raw) >= max_logs_per_response:
            if high == low:
                return result("SINGLE_BLOCK_LIMIT")
            chunk = max(1, (high - low + 1) // 2)
            continue
        try:
            additions = _merge([], [_sanitize(item, scope, low, high) for item in raw])
            updated_events = _merge(events, additions)
        except _Invalid:
            return result("INVALID_LOG_RESPONSE")
        updated_ranges = ranges + [{"fromBlock": low, "toBlock": high, "eventCount": len(additions)}]
        if checkpoint_path is not None:
            try:
                boundary = _block_hash(client, high)
                if any(e["blockNumber"] == high and e["blockHash"] != boundary for e in additions):
                    return result("BLOCK_HASH_MISMATCH")
            except _Invalid:
                return result("INVALID_BLOCK_HEADER")
            except Exception as error:
                return result(_error_code(error))
            try:
                _save(checkpoint_path, scope, updated_ranges, updated_events, high, boundary)
            except OSError:
                return result("CHECKPOINT_WRITE_FAILED")
        ranges, events, last = updated_ranges, updated_events, high
        low = high + 1
        chunk = min(initial_chunk, chunk * 2)
    return result()
