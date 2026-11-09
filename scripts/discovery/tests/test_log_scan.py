"""Deterministic scanner boundary/recovery tests; no RPC or credentials required."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


_SPEC = importlib.util.spec_from_file_location("log_scan", Path(__file__).resolve().parents[1] / "log_scan.py")
assert _SPEC is not None and _SPEC.loader is not None
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
scan_logs = _MODULE.scan_logs

ADDRESS = "0x" + "ab" * 20
TOPIC = "0x" + "11" * 32
OTHER_TOPIC = "0x" + "22" * 32
TASK = "0x" + "33" * 32


def block_hash(number):
    return "0x" + f"{number + 100:064x}"


def event(number, index=0, **changes):
    value = {
        "address": ADDRESS, "blockNumber": hex(number), "blockHash": block_hash(number),
        "transactionHash": "0x" + f"{number * 100 + index:064x}",
        "logIndex": hex(index), "topics": [TOPIC], "removed": False,
        "data": TASK + "de" * 100, "unexpectedSecret": "never-persist-this",
    }
    value.update(changes)
    return value


class RpcError(Exception):
    def __init__(self, code, message="provider URL or credential must not leak", rpc_code=None):
        super().__init__(message)
        self.code, self.rpc_code = code, rpc_code


class Client:
    def __init__(self, handler=None, events=()):
        self.handler, self.events, self.calls = handler, list(events), []
        self.reorg = False

    def call(self, method, params):
        self.calls.append((method, params))
        if method == "eth_getBlockByNumber":
            number = int(params[0], 16)
            return {"number": hex(number), "hash": block_hash(number + (1 if self.reorg else 0))}
        query = params[0]
        low, high = int(query["fromBlock"], 16), int(query["toBlock"], 16)
        if self.handler is not None:
            return self.handler(low, high)
        return [deepcopy(item) for item in self.events if low <= int(item["blockNumber"], 16) <= high]


class ScannerTests(unittest.TestCase):
    def scan(self, client, **options):
        defaults = dict(address=ADDRESS, topics=[TOPIC], from_block=0, to_block=3)
        defaults.update(options)
        return scan_logs(client, **defaults)

    def test_dense_range_splits_without_losing_events(self):
        client = Client(events=[event(n) for n in range(4)])
        result = self.scan(client, initial_chunk=4, max_logs_per_response=2)
        self.assertTrue(result["complete"])
        self.assertEqual([e["blockNumber"] for e in result["events"]], list(range(4)))
        self.assertEqual(sum(r["eventCount"] for r in result["ranges"]), 4)
        self.assertEqual(result["lastCompletedBlock"], 3)
        for _, params in client.calls:
            self.assertEqual(params[0]["topics"], [[TOPIC]])

    def test_single_block_at_cap_is_partial_not_success(self):
        result = self.scan(Client(events=[event(0, 0), event(0, 1)]), to_block=0, max_logs_per_response=2)
        self.assertFalse(result["complete"])
        self.assertEqual(result["stopReason"], "SINGLE_BLOCK_LIMIT")
        self.assertEqual(result["events"], [])
        self.assertIsNone(result["lastCompletedBlock"])

    def test_invalid_logs_fail_closed(self):
        mutations = [
            {"address": "0x" + "cd" * 20}, {"removed": True}, {"removed": None},
            {"blockNumber": "0x10"}, {"blockNumber": "0x00"},
            {"blockHash": "not-a-hash"}, {"transactionHash": "0x12"},
            {"logIndex": "-1"}, {"topics": []}, {"topics": [OTHER_TOPIC]},
            {"topics": [TOPIC, "bad-indexed-word"]},
        ]
        for changes in mutations:
            with self.subTest(changes=changes):
                result = self.scan(Client(handler=lambda low, high: [event(0, **changes)]))
                self.assertEqual(result["stopReason"], "INVALID_LOG_RESPONSE")
                self.assertEqual(result["events"], [])

    def test_duplicate_reordered_logs_are_sorted_and_deduplicated(self):
        client = Client(handler=lambda low, high: [event(1), event(0), event(1)])
        result = self.scan(client, to_block=1)
        self.assertTrue(result["complete"])
        self.assertEqual([e["blockNumber"] for e in result["events"]], [0, 1])
        self.assertEqual(result["ranges"][0]["eventCount"], 2)
        self.assertNotIn("data", result["events"][0])
        self.assertNotIn("unexpectedSecret", result["events"][0])

    def test_conflicting_duplicate_or_block_hash_is_rejected(self):
        for additions in (
            [event(0), event(0, topics=[TOPIC, OTHER_TOPIC], address="0x" + "cd" * 20)],
            [event(0), event(0, 1, blockHash=block_hash(1))],
            [event(0), event(0, transactionHash="0x" + "ff" * 32)],
        ):
            with self.subTest(additions=additions):
                self.assertEqual(self.scan(Client(handler=lambda low, high: additions))["stopReason"], "INVALID_LOG_RESPONSE")

    def test_failure_does_not_skip_gap_or_leak_error(self):
        def handler(low, high):
            if low >= 2:
                raise RpcError("ACCESS_DENIED")
            return [event(0)]
        client = Client(handler=handler)
        result = self.scan(client, initial_chunk=2)
        self.assertEqual(result["lastCompletedBlock"], 1)
        self.assertEqual(result["stopReason"], "ACCESS_DENIED")
        self.assertFalse(result["complete"])
        self.assertEqual(len(client.calls), 2)
        self.assertNotIn("credential", json.dumps(result))

    def test_timeout_and_known_range_error_reduce_chunk(self):
        for error in (
            RpcError("TIMEOUT"), RpcError("RPC_RANGE_LIMIT"),
            RpcError("RPC_ERROR", "block range exceeds limit", -32005),
        ):
            def handler(low, high):
                if high > low:
                    raise error
                return [event(low)]
            with self.subTest(code=error.code):
                result = self.scan(Client(handler=handler), initial_chunk=4)
                self.assertTrue(result["complete"])
                self.assertEqual(len(result["events"]), 4)

    def test_rate_limits_stop_without_range_retries(self):
        def handler(low, high):
            raise RpcError("RATE_LIMITED", "block range requests throttled", -32005)
        client = Client(handler=handler)
        result = self.scan(client)
        self.assertEqual(result["stopReason"], "RATE_LIMITED")
        self.assertEqual(len(client.calls), 1)

    def test_task_id_requires_explicit_topic_and_discards_remaining_payload(self):
        result = self.scan(Client(events=[event(0)]), task_topics=[TOPIC])
        self.assertEqual(result["events"][0]["taskId"], TASK)
        self.assertNotIn("dededede", json.dumps(result))
        other = self.scan(Client(events=[event(0, topics=[OTHER_TOPIC])]), topics=[TOPIC, OTHER_TOPIC], task_topics=[TOPIC])
        self.assertNotIn("taskId", other["events"][0])
        for data in ("0x12", "not-hex", "0x" + "a" * 65):
            with self.subTest(data=data):
                invalid = self.scan(Client(events=[event(0, data=data)]), task_topics=[TOPIC])
                self.assertEqual(invalid["stopReason"], "INVALID_LOG_RESPONSE")

    def test_resume_retains_earlier_events_ranges_and_safe_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            def first_handler(low, high):
                if low >= 2:
                    raise RpcError("BUDGET_EXCEEDED")
                return [event(0)]
            first = self.scan(Client(handler=first_handler), initial_chunk=2, checkpoint_path=path, task_topics=[TOPIC], scope_id="pinned-target")
            self.assertFalse(first["complete"])
            text = path.read_text()
            self.assertNotIn("never-persist-this", text)
            self.assertNotIn("dededede", text)
            second_client = Client(events=[event(2)])
            second = self.scan(second_client, initial_chunk=2, checkpoint_path=path, task_topics=[TOPIC], scope_id="pinned-target")
            self.assertTrue(second["complete"])
            self.assertEqual([e["blockNumber"] for e in second["events"]], [0, 2])
            self.assertEqual(second["ranges"], [
                {"fromBlock": 0, "toBlock": 1, "eventCount": 1},
                {"fromBlock": 2, "toBlock": 3, "eventCount": 1},
            ])
            self.assertEqual(second_client.calls[0], ("eth_getBlockByNumber", ["0x1", False]))
            completed_client = Client()
            completed = self.scan(completed_client, initial_chunk=2, checkpoint_path=path, task_topics=[TOPIC], scope_id="pinned-target")
            self.assertTrue(completed["complete"])
            self.assertEqual(completed["events"], second["events"])
            self.assertEqual(len(completed_client.calls), 1)

    def test_checkpoint_scope_mismatch_and_reorg_preserve_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            self.scan(Client(events=[event(0)]), checkpoint_path=path, scope_id="original")
            original = path.read_bytes()
            changed = Client()
            mismatch = self.scan(changed, checkpoint_path=path, scope_id="different")
            self.assertEqual(mismatch["stopReason"], "CHECKPOINT_SCOPE_MISMATCH")
            self.assertEqual(changed.calls, [])
            client = Client()
            client.reorg = True
            reorg = self.scan(client, checkpoint_path=path, scope_id="original")
            self.assertEqual(reorg["stopReason"], "CHECKPOINT_REORG")
            self.assertFalse(reorg["complete"])
            self.assertEqual(reorg["events"], [])
            self.assertEqual(path.read_bytes(), original)

    def test_corrupt_or_tampered_checkpoint_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            self.scan(Client(events=[event(0)]), checkpoint_path=path)
            valid = json.loads(path.read_text())
            for mutate in (
                lambda saved: saved["ranges"][0].update(eventCount=999),
                lambda saved: saved["events"][0].update(data="secret"),
                lambda saved: saved["events"][0].update(blockNumber=20),
                lambda saved: saved.update(lastCompletedBlock=True),
            ):
                saved = deepcopy(valid)
                mutate(saved)
                path.write_text(json.dumps(saved))
                result = self.scan(Client(), checkpoint_path=path)
                self.assertEqual(result["stopReason"], "CHECKPOINT_INVALID")


if __name__ == "__main__":
    unittest.main()
