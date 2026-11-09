"""Offline bounded hybrid tests; these fixtures do not establish live readiness."""

import argparse
from contextlib import redirect_stderr
from copy import deepcopy
import json
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bsc_rpc_probe as probe
from rpc_client import RpcError


def block_hash(number):
    return "0x" + f"{number:064x}"


class FakeRPC:
    endpoint_host = "fixture.invalid"
    timeout_seconds = 0.1

    def __init__(self, evidence, rows=None, *, failure=None, fail_after=None, wrong_chain=False,
                 wide_limit=None, wrong_implementation=False, tamper_receipt=False):
        self.evidence, self.rows = evidence, rows or []
        self.failure, self.fail_after, self.wide_limit = failure, fail_after, wide_limit
        self.wrong_chain, self.wrong_implementation = wrong_chain, wrong_implementation
        self.tamper_receipt = tamper_receipt
        self.requests_made, self.events, self.calls = 0, [], []
        self.header_override = {}

    def call(self, method, params):
        self.requests_made += 1
        self.calls.append((method, deepcopy(params)))
        self.events.append({"method": method, "outcome": "fixture"})
        if self.fail_after is not None and self.requests_made > self.fail_after:
            raise RpcError("REQUEST_BUDGET_EXHAUSTED")
        if method == "eth_chainId":
            return "0x1" if self.wrong_chain else "0x38"
        if method == "eth_getBlockByNumber":
            number = 4 if params[0] == "finalized" else int(params[0], 16)
            return {"number": hex(number), "hash": self.header_override.get(number, block_hash(number)), "timestamp": hex(100 + number)}
        if method == "eth_getCode":
            return "0x6000"
        if method == "eth_getStorageAt":
            contract = self.evidence["contracts"][params[0]]
            address = "0x" + "ff" * 20 if self.wrong_implementation else contract["expectedImplementation"]
            return "0x" + "00" * 12 + address[2:]
        if method == "eth_getLogs":
            if self.failure:
                raise RpcError(self.failure)
            low, high = int(params[0]["fromBlock"], 16), int(params[0]["toBlock"], 16)
            if self.wide_limit and high - low + 1 > self.wide_limit:
                raise RpcError("RPC_RANGE_LIMIT")
            return [deepcopy(row) for row in self.rows if low <= int(row["blockNumber"], 16) <= high]
        if method == "eth_getTransactionReceipt":
            row = deepcopy(next(row for row in self.rows if row["transactionHash"] == params[0]))
            if self.tamper_receipt:
                row["topics"][1] = block_hash(999)
            return {"transactionHash": row["transactionHash"], "blockHash": row["blockHash"],
                    "blockNumber": row["blockNumber"], "status": "0x1", "logs": [row]}
        raise AssertionError(method)


class HybridTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.real = probe.load_evidence()
        address = sorted(cls.real["contracts"])[0]
        cls.address = address
        cls.evidence = {**cls.real, "contracts": {address: deepcopy(cls.real["contracts"][address])}}

    def event(self, number, *, name="AggregateFinalized", batch=7, index=None):
        descriptor = next(value for value in self.evidence["contracts"][self.address]["events"].values() if value["name"] == name)
        return {"address": self.address, "blockNumber": hex(number), "blockHash": block_hash(number),
                "transactionHash": block_hash(1000 + number), "logIndex": hex(number if index is None else index),
                "topics": [descriptor["topic0"], block_hash(batch)],
                "data": "0x" + "de" * 32 * descriptor["dataWords"], "removed": False,
                "extraPrivate": "FORBIDDEN_FIXTURE_VALUE"}

    def args(self, output):
        return argparse.Namespace(max_run_seconds=60, min_request_interval=0, max_requests=60,
                                  timeout=0.1, lookback_blocks=4, from_block=None, to_block=None,
                                  chunk_size=2, receipt_limit=1, output_dir=Path(output))

    def test_source_loader_binds_four_configured_contracts_and_source_files(self):
        self.assertEqual(4, len(self.real["contracts"]))
        self.assertEqual(3, len(self.real["sourceFiles"]))
        self.assertEqual(56, self.real["chainId"])
        self.assertTrue(all(len(item["events"]) == 5 for item in self.real["contracts"].values()))

    def test_known_lifecycle_sanitizes_amounts_and_public_batch_identity(self):
        rows = [self.event(2, name="AggregateDispatched"), self.event(3)]
        rpc = FakeRPC(self.evidence, rows)
        scan = probe.scan_logs(rpc, self.evidence, 1, 4, chunk_size=2)
        self.assertTrue(scan["complete"])
        self.assertEqual(["AggregateDispatched", "AggregateFinalized"], [e["event"] for e in scan["events"]])
        self.assertEqual(["7", "7"], [e["batchId"] for e in scan["events"]])
        text = json.dumps(scan)
        self.assertNotIn("FORBIDDEN_FIXTURE", text)
        self.assertNotIn("de" * 32, text)
        self.assertNotIn('"data"', text)
        self.assertTrue(all(e["contractAddress"] == self.address for e in scan["events"]))

    def test_known_range_error_splits_and_retains_all_events(self):
        rpc = FakeRPC(self.evidence, [self.event(1), self.event(4)], wide_limit=2)
        scan = probe.scan_logs(rpc, self.evidence, 1, 4, chunk_size=4)
        self.assertTrue(scan["complete"])
        self.assertEqual(2, len(scan["events"]))
        ranges = [params[0] for method, params in rpc.calls if method == "eth_getLogs"]
        self.assertEqual("0x4", ranges[0]["toBlock"])
        self.assertEqual("0x2", ranges[1]["toBlock"])

    def test_dense_result_splits_but_single_block_cap_stops(self):
        rows = [self.event(1), self.event(2), self.event(3)]
        scan = probe.scan_logs(FakeRPC(self.evidence, rows), self.evidence, 1, 4, chunk_size=4, max_logs=3)
        self.assertTrue(scan["complete"])
        capped = probe.scan_logs(FakeRPC(self.evidence, [self.event(1)]), self.evidence, 1, 1, max_logs=1)
        self.assertFalse(capped["complete"])
        self.assertEqual("SINGLE_BLOCK_LIMIT", capped["stopReason"])
        self.assertIsNone(capped["lastCompletedBlock"])

    def test_quota_or_access_failure_is_not_split_or_retried(self):
        for code in ("RATE_LIMITED", "PROXY_TUNNEL_DENIED", "REQUEST_BUDGET_EXHAUSTED"):
            rpc = FakeRPC(self.evidence, failure=code)
            result = probe.scan_logs(rpc, self.evidence, 1, 4)
            self.assertEqual(code, result["stopReason"])
            self.assertEqual(1, rpc.requests_made)

    def test_timeout_reduces_range_then_stops_at_single_block(self):
        rpc = FakeRPC(self.evidence, failure="REQUEST_TIMEOUT")
        result = probe.scan_logs(rpc, self.evidence, 1, 4, chunk_size=4)
        self.assertEqual("REQUEST_TIMEOUT", result["stopReason"])
        self.assertEqual(3, rpc.requests_made)
        self.assertIsNone(result["lastCompletedBlock"])

    def test_duplicate_reordered_events_deduplicate_canonically(self):
        one, two = self.event(1), self.event(2)
        result = probe.scan_logs(FakeRPC(self.evidence, [two, one, one]), self.evidence, 1, 2)
        self.assertTrue(result["complete"])
        self.assertEqual([1, 2], [event["blockNumber"] for event in result["events"]])

    def test_invalid_event_scope_removed_and_unapproved_topic_fail_closed(self):
        base = self.event(2)
        variants = []
        for key, value in [("address", "0x" + "ef" * 20), ("removed", True),
                           ("blockHash", None), ("data", "0x"), ("topics", [block_hash(99), block_hash(7)])]:
            variants.append({**base, key: value})
        variants.append({key: value for key, value in base.items() if key != "removed"})
        for row in variants:
            with self.subTest(keys=row.keys()):
                result = probe.scan_logs(FakeRPC(self.evidence, [row]), self.evidence, 1, 4)
                self.assertFalse(result["complete"])
                self.assertEqual([], result["events"])

    def test_checkpoint_resume_retains_prior_events_and_checks_boundary(self):
        rows = [self.event(1), self.event(3)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            first = probe.scan_logs(FakeRPC(self.evidence, rows, fail_after=2), self.evidence, 1, 4,
                                    chunk_size=2, checkpoint_path=path, scope_id="fixture")
            self.assertEqual(2, first["lastCompletedBlock"])
            self.assertFalse(first["complete"])
            rpc = FakeRPC(self.evidence, rows)
            resumed = probe.scan_logs(rpc, self.evidence, 1, 4, chunk_size=2, checkpoint_path=path, scope_id="fixture")
            self.assertTrue(resumed["complete"])
            self.assertEqual([1, 3], [event["blockNumber"] for event in resumed["events"]])
            self.assertEqual(("eth_getBlockByNumber", ["0x2", False]), rpc.calls[0])
            self.assertNotIn("FORBIDDEN_FIXTURE", path.read_text())
            complete = probe.scan_logs(FakeRPC(self.evidence, rows), self.evidence, 1, 4,
                                       checkpoint_path=path, scope_id="fixture")
            self.assertEqual(resumed["events"], complete["events"])

    def test_checkpoint_reorg_and_scope_mismatch_preserve_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            probe.scan_logs(FakeRPC(self.evidence, [self.event(1)]), self.evidence, 1, 2,
                            checkpoint_path=path, scope_id="fixture")
            before = path.read_bytes()
            rpc = FakeRPC(self.evidence)
            rpc.header_override[2] = block_hash(999)
            result = probe.scan_logs(rpc, self.evidence, 1, 2, checkpoint_path=path, scope_id="fixture")
            self.assertEqual("CHECKPOINT_REORG", result["stopReason"])
            result = probe.scan_logs(FakeRPC(self.evidence), self.evidence, 1, 2, checkpoint_path=path, scope_id="other")
            self.assertEqual("CHECKPOINT_SCOPE_MISMATCH", result["stopReason"])
            self.assertEqual(before, path.read_bytes())

    def test_checkpoint_rejects_sensitive_or_inconsistent_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            probe.scan_logs(FakeRPC(self.evidence, [self.event(1)]), self.evidence, 1, 2, checkpoint_path=path)
            saved = json.loads(path.read_text())
            saved["events"][0]["data"] = "FORBIDDEN_FIXTURE"
            path.write_text(json.dumps(saved))
            result = probe.scan_logs(FakeRPC(self.evidence), self.evidence, 1, 2, checkpoint_path=path)
            self.assertEqual("CHECKPOINT_INVALID", result["stopReason"])

    def test_wrong_chain_and_implementation_stop_before_scan(self):
        for options, reason in [({"wrong_chain": True}, "WRONG_CHAIN"),
                                ({"wrong_implementation": True}, "IMPLEMENTATION_SOURCE_MISMATCH")]:
            with tempfile.TemporaryDirectory() as directory:
                rpc = FakeRPC(self.evidence, **options)
                result = probe.run_probe(self.args(directory), rpc, self.evidence)
            self.assertEqual(reason, result["stopReason"])
            self.assertNotIn("eth_getLogs", [call[0] for call in rpc.calls])

    def test_probe_receipt_reconciles_lifecycle_without_reading_wallet_data(self):
        rows = [self.event(2, name="AggregateDispatched"), self.event(3)]
        with tempfile.TemporaryDirectory() as directory:
            result = probe.run_probe(self.args(directory), FakeRPC(self.evidence, rows), self.evidence)
        self.assertEqual("bounded_batch_sample_observed", result["status"])
        self.assertTrue(result["receiptSamples"][0]["receiptEventMatch"])
        self.assertEqual("not_established", result["productionReadiness"])
        self.assertEqual(2, len(result["scan"]["events"]))
        self.assertNotIn("FORBIDDEN_FIXTURE", json.dumps(result))

    def test_probe_receipt_batch_id_mismatch_is_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            result = probe.run_probe(self.args(directory), FakeRPC(self.evidence, [self.event(2)], tamper_receipt=True), self.evidence)
        self.assertEqual("partial", result["status"])
        self.assertEqual("RECEIPT_EVENT_MISMATCH", result["stopReason"])

    def test_empty_scope_does_not_establish_global_zero_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            result = probe.run_probe(self.args(directory), FakeRPC(self.evidence), self.evidence)
        self.assertEqual("bounded_sample_empty", result["status"])
        self.assertTrue(any("not proof of no Primus usage" in warning for warning in result["warnings"]))

    def test_command_bounds_reject_costly_or_unbounded_requests(self):
        for args in [("--lookback-blocks", "100001"), ("--max-requests", "81"),
                     ("--max-run-seconds", "301"), ("--min-request-interval", "0"),
                     ("--receipt-limit", "4")]:
            with self.subTest(args=args), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                probe.arguments(list(args))

    def test_scanner_limits_fail_before_network(self):
        for low, high, chunk in [(-1, 4, 1), (4, 1, 1), (1, 100001, 1), (1, 4, 0), (1, 4, 50001)]:
            rpc = FakeRPC(self.evidence)
            with self.assertRaises(RpcError) as caught:
                probe.scan_logs(rpc, self.evidence, low, high, chunk_size=chunk)
            self.assertEqual("INVALID_SCAN_LIMITS", caught.exception.code)
            self.assertEqual(0, rpc.requests_made)

    def test_target_hash_change_after_sample_is_partial(self):
        class ChangingRPC(FakeRPC):
            target_reads = 0

            def call(self, method, params):
                result = super().call(method, params)
                if method == "eth_getBlockByNumber" and params[0] == "0x4":
                    self.target_reads += 1
                    if self.target_reads == 2:
                        result["hash"] = block_hash(999)
                return result

        with tempfile.TemporaryDirectory() as directory:
            result = probe.run_probe(self.args(directory), ChangingRPC(self.evidence, [self.event(2)]), self.evidence)
        self.assertEqual("partial", result["status"])
        self.assertEqual("TARGET_BLOCK_CHANGED", result["stopReason"])


if __name__ == "__main__":
    unittest.main()
