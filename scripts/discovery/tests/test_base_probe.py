"""Offline probe projections and discovery outcomes; no live-data claims."""

import argparse
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import base_probe
from rpc_client import RpcError


def task_encoding(status=3, submitted=1700000000):
    # Canonical tuple head + private-looking template fixture + empty arrays.
    # This is synthetic test data, never a live task or attestation.
    secret = b"SENSITIVE_TEMPLATE_FIXTURE"
    word = lambda value: value.to_bytes(32, "big")
    values = [256, 1, 320, 352, submitted, 0, 0, status]
    return "0x" + (word(32) + b"".join(word(v) for v in values)
                    + word(len(secret)) + secret.ljust(32, b"\0") + word(0) + word(0)).hex()


class FakeTransport:
    endpoint_host = "fixture.invalid"
    timeout_seconds = 0.1

    def __init__(self, error=None, chain_id="0x2105"):
        self.requests_made = 0
        self.events = []
        self.error = error
        self.chain_id = chain_id

    def call(self, method, params):
        self.requests_made += 1
        self.events.append({"method": method, "outcome": self.error or "ok"})
        if self.error:
            raise RpcError(self.error)
        if method == "eth_chainId":
            return self.chain_id
        if method == "eth_blockNumber":
            return "0x64"
        if method == "eth_getBlockByNumber":
            return {"number": "0x64", "hash": "0x" + "ab" * 32, "timestamp": "0x65"}
        if method == "eth_getCode":
            return "0x6000"
        if method == "eth_getStorageAt":
            return "0x" + "00" * 32
        if method == "eth_getLogs":
            return []
        raise AssertionError("Unexpected method " + method)


class BaseProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source, cls.abi = base_probe.source_manifest()

    def args(self, output):
        return argparse.Namespace(max_run_seconds=30, max_requests=40, timeout=0.1,
                                  chunk_size=100, to_block=None, from_block=None,
                                  lookback_blocks=2, output_dir=Path(output), receipt_limit=2,
                                  min_request_interval=0)

    def test_official_source_subset_is_view_only_and_hash_pinned(self):
        self.assertEqual(8453, self.source["chainId"])
        self.assertIsNone(self.source["deploymentBlock"])
        self.assertEqual("source_documented_runtime_unverified", self.source["reviewStatus"])
        self.assertEqual({"queryTask", "taskTimeout"}, {e["name"] for e in self.abi if e["type"] == "function"})
        self.assertTrue(all(e.get("stateMutability") == "view" for e in self.abi if e["type"] == "function"))

    def test_task_projection_uses_abi_status_index_seven(self):
        result = base_probe.project_task_state(task_encoding(), self.abi, self.source)
        self.assertEqual(3, result["nativeStatusCode"])
        self.assertEqual("PARTIAL_SUCCESS_SETTLED", result["sourceDocumentedName"])
        self.assertEqual("1700000000", result["submittedAtUnix"])
        self.assertEqual("not_run", result["cryptographicVerification"])
        serialized = json.dumps(result)
        self.assertNotIn("SENSITIVE_TEMPLATE", serialized)
        self.assertNotIn(b"SENSITIVE_TEMPLATE".hex(), serialized)
        self.assertNotIn("taskResults", serialized)

    def test_unknown_enum_is_preserved_without_inventing_status(self):
        result = base_probe.project_task_state(task_encoding(status=8), self.abi, self.source)
        self.assertEqual(8, result["nativeStatusCode"])
        self.assertEqual("UNKNOWN_NATIVE_ENUM", result["sourceDocumentedName"])

    def test_zero_record_does_not_establish_task_existence(self):
        result = base_probe.project_task_state(task_encoding(status=0, submitted=0), self.abi, self.source)
        self.assertEqual("not_confirmed", result["taskRecordPresence"])

    def test_malformed_task_encoding_is_rejected(self):
        valid = task_encoding()
        for value in ["0x", "0xzz", "0x" + "00" * 32, "0x" + "00" * 32 + valid[66:],
                      task_encoding(status=256), task_encoding(submitted=2**64)]:
            with self.subTest(value=value[:20]), self.assertRaises(RpcError):
                base_probe.project_task_state(value, self.abi, self.source)

    def test_invalid_dynamic_tuple_pointer_is_rejected(self):
        raw = bytearray.fromhex(task_encoding()[2:])
        raw[32:64] = (1).to_bytes(32, "big")
        with self.assertRaises(RpcError) as caught:
            base_probe.project_task_state("0x" + raw.hex(), self.abi, self.source)
        self.assertEqual("INVALID_TASK_STATE_ENCODING", caught.exception.code)

    def test_rpc_quantities_require_canonical_hex(self):
        self.assertEqual(0, base_probe.quantity("0x0"))
        for value in [None, 10, True, "1", "0x", "0x01", "0xzz", "-1", "0x" + "f" * 65]:
            with self.subTest(value=value), self.assertRaises(RpcError):
                base_probe.quantity(value)

    def test_block_header_requires_hash_and_quantities(self):
        with self.assertRaises(RpcError):
            base_probe.block_header({"number": "0x1", "hash": "0xabc", "timestamp": "0x1"})

    def test_deadline_refuses_to_start_another_request(self):
        transport = FakeTransport()
        client = base_probe.DeadlineClient(transport, time.monotonic() + 0.01)
        with self.assertRaises(RpcError) as caught:
            client.call("eth_chainId", [])
        self.assertEqual("RUN_DEADLINE_EXHAUSTED", caught.exception.code)
        self.assertEqual(0, transport.requests_made)

    def test_access_denial_stops_after_one_call_with_safe_report(self):
        with tempfile.TemporaryDirectory() as out:
            transport = FakeTransport(error="PROXY_TUNNEL_DENIED")
            result = base_probe.run_probe(self.args(out), transport, self.source, self.abi)
        self.assertEqual("blocked", result["status"])
        self.assertEqual("PROXY_TUNNEL_DENIED", result["stopReason"])
        self.assertEqual(1, result["requestCount"])
        self.assertNotIn("scan", result)
        self.assertEqual("not_established", result["productionReadiness"])

    def test_request_pacing_spaces_calls_without_retrying(self):
        transport = FakeTransport()
        clock = [0.0]
        client = base_probe.DeadlineClient(transport, 100, min_interval_seconds=2)
        with patch("base_probe.time.monotonic", side_effect=lambda: clock[0]), patch(
                "base_probe.time.sleep", side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)) as sleep:
            client.call("eth_chainId", [])
            client.call("eth_chainId", [])
        self.assertEqual(2, transport.requests_made)
        self.assertEqual(2, clock[0])
        sleep.assert_called_once_with(2)

    def test_pacing_cannot_overrun_the_run_deadline(self):
        transport = FakeTransport()
        client = base_probe.DeadlineClient(transport, 1.5, min_interval_seconds=2)
        with patch("base_probe.time.monotonic", return_value=0), patch("base_probe.time.sleep") as sleep:
            client.call("eth_chainId", [])
            with self.assertRaises(RpcError) as caught:
                client.call("eth_chainId", [])
        self.assertEqual("RUN_DEADLINE_EXHAUSTED", caught.exception.code)
        self.assertEqual(1, transport.requests_made)
        sleep.assert_not_called()

    def test_wrong_chain_stops_before_contract_reads(self):
        with tempfile.TemporaryDirectory() as out:
            transport = FakeTransport(chain_id="0x1")
            result = base_probe.run_probe(self.args(out), transport, self.source, self.abi)
        self.assertEqual("WRONG_CHAIN", result["stopReason"])
        self.assertEqual(1, result["requestCount"])

    def test_zero_event_scope_is_not_reported_as_live_task_validation(self):
        with tempfile.TemporaryDirectory() as out:
            result = base_probe.run_probe(self.args(out), FakeTransport(), self.source, self.abi)
        self.assertEqual("bounded_sample_empty", result["status"])
        self.assertEqual({}, result["eventCounts"])
        self.assertEqual("not_established", result["productionReadiness"])
        self.assertTrue(any("not evidence of no Primus usage" in w for w in result["warnings"]))

    def known_task_transport(self, tampered_receipt=False):
        source = self.source
        topic = next(e["topic0"] for e in source["events"] if e["name"] == "SubmitTask")
        event = {"address": source["address"], "blockNumber": "0x64", "blockHash": "0x" + "ab" * 32,
                 "transactionHash": "0x" + "cd" * 32, "logIndex": "0x1", "removed": False,
                 "topics": [topic, "0x" + "00" * 32],
                 "data": "0x" + "aa" * 32 + b"PRIVATE_LOOKING_EVENT_FIXTURE".hex()}

        class KnownTask(FakeTransport):
            def call(self, method, params):
                if method not in ("eth_getLogs", "eth_getTransactionReceipt", "eth_call"):
                    return super().call(method, params)
                self.requests_made += 1
                self.events.append({"method": method, "outcome": "ok"})
                if method == "eth_getLogs":
                    return [event.copy()]
                if method == "eth_call":
                    assert params[1] == "0x64"
                    assert params[0]["data"].endswith("aa" * 32)
                    return task_encoding()
                receipt_event = event.copy()
                if tampered_receipt:
                    receipt_event["data"] = "0x" + "bb" * 32
                return {"transactionHash": event["transactionHash"], "blockHash": event["blockHash"],
                        "blockNumber": "0x64", "status": "0x1", "gasUsed": "0x2",
                        "effectiveGasPrice": "0x3", "logs": [receipt_event]}

        return KnownTask()

    def test_offline_known_task_flow_reconciles_pinned_state_without_raw_payloads(self):
        with tempfile.TemporaryDirectory() as out:
            result = base_probe.run_probe(self.args(out), self.known_task_transport(), self.source, self.abi)
        self.assertEqual("bounded_sample_observed", result["status"])
        self.assertEqual({"SubmitTask": 1}, result["eventCounts"])
        self.assertTrue(result["receiptSamples"][0]["receiptEventMatch"])
        self.assertEqual(3, result["taskStateSample"]["nativeStatusCode"])
        self.assertEqual("not_established", result["productionReadiness"])
        text = json.dumps(result)
        self.assertNotIn(b"PRIVATE_LOOKING_EVENT_FIXTURE".hex(), text)
        self.assertNotIn(b"SENSITIVE_TEMPLATE_FIXTURE".hex(), text)

    def test_receipt_task_mismatch_stops_before_native_state_query(self):
        with tempfile.TemporaryDirectory() as out:
            transport = self.known_task_transport(tampered_receipt=True)
            result = base_probe.run_probe(self.args(out), transport, self.source, self.abi)
        self.assertEqual("partial", result["status"])
        self.assertEqual("RECEIPT_TASK_ID_MISMATCH", result["stopReason"])
        self.assertNotIn("eth_call", [event["method"] for event in transport.events])

    def test_receipt_cost_does_not_pretend_execution_gas_is_total_fee(self):
        event = {"address": "0x" + "11" * 20, "transactionHash": "0x" + "ab" * 32,
                 "blockHash": "0x" + "cd" * 32, "blockNumber": 10, "logIndex": 2,
                 "topic0": "0x" + "ef" * 32}
        receipt = {"transactionHash": event["transactionHash"], "blockHash": event["blockHash"],
                   "blockNumber": "0xa", "status": "0x1", "gasUsed": "0x2", "effectiveGasPrice": "0x3",
                   "l1Fee": "0x4", "logs": [{**event, "logIndex": "0x2", "topics": [event["topic0"]]}]}
        projected = base_probe.receipt_projection(receipt, event)
        self.assertEqual("6", projected["executionGasCostBaseUnits"])
        self.assertEqual("4", projected["providerReportedL1FeeBaseUnits"])
        self.assertIn("not_computed", projected["totalTransactionFee"])
        receipt["blockHash"] = "0x" + "00" * 32
        with self.assertRaises(RpcError):
            base_probe.receipt_projection(receipt, event)

    def test_report_write_is_atomic_json(self):
        with tempfile.TemporaryDirectory() as out:
            path = Path(out) / "report.json"
            base_probe.atomic_json(path, {"status": "fixture"})
            self.assertEqual({"status": "fixture"}, json.loads(path.read_text()))
            self.assertFalse(path.with_name("report.json.tmp").exists())

    def test_receipt_must_reconcile_task_id_not_only_event_identity(self):
        event = {"address": "0x" + "11" * 20, "transactionHash": "0x" + "ab" * 32,
                 "blockHash": "0x" + "cd" * 32, "blockNumber": 10, "logIndex": 2,
                 "topic0": "0x" + "ef" * 32, "taskId": "0x" + "aa" * 32}
        log = {**event, "logIndex": "0x2", "topics": [event["topic0"]], "data": "0x" + "bb" * 32}
        receipt = {"transactionHash": event["transactionHash"], "blockHash": event["blockHash"],
                   "blockNumber": "0xa", "status": "0x1", "gasUsed": "0x2", "effectiveGasPrice": "0x3", "logs": [log]}
        with self.assertRaises(RpcError) as caught:
            base_probe.receipt_projection(receipt, event)
        self.assertEqual("RECEIPT_TASK_ID_MISMATCH", caught.exception.code)
        log["data"] = event["taskId"] + b"SENSITIVE_TRAILING_FIXTURE".hex()
        projected = base_probe.receipt_projection(receipt, event)
        self.assertTrue(projected["receiptEventMatch"])
        self.assertNotIn(b"SENSITIVE_TRAILING_FIXTURE".hex(), json.dumps(projected))


if __name__ == "__main__":
    unittest.main()
