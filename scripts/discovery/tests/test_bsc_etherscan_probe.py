"""Synthetic BSC discovery tests; never live provider or private user data."""

import argparse
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bsc_etherscan_probe as probe
from etherscan_client import EtherscanError


IMPL = "0x" + "22" * 20
TX = "0x" + "ab" * 32
BLOCK = "0x" + "cd" * 32
SENSITIVE = "PRIVATE_LOOKING_FIXTURE_NOT_FOR_REPORT"


def fixture_abi(indexed=False):
    return [
        {"type": "event", "name": "AggregateDispatched", "anonymous": False,
         "inputs": [{"name": "aggregateId", "type": "uint256", "indexed": indexed}]},
        {"type": "event", "name": "AggregateFinalized", "anonymous": False,
         "inputs": [{"name": "aggregateId", "type": "uint256", "indexed": False},
                    {"name": "exchangeRate", "type": "uint64", "indexed": False}]},
    ]


def source_entry(proxy=False, abi=None):
    return {"ContractName": "SyntheticAggregator", "SourceCode": "contract " + SENSITIVE,
            "Proxy": "1" if proxy else "0", "Implementation": IMPL if proxy else "",
            "ABI": json.dumps(fixture_abi() if abi is None else abi)}


class FakeClient:
    def __init__(self, pages=None, proxy=False, error=None):
        self.pages = pages if pages is not None else [[]]
        self.proxy = proxy
        self.error = error
        self.requests_made = 0
        self.events = []
        self.calls = []
        self.abi = fixture_abi()
        self.receipt = None

    def record(self, action, *args):
        self.requests_made += 1
        self.events.append({"action": action, "outcome": self.error or "ok"})
        self.calls.append((action, *args))
        if self.error:
            raise EtherscanError(self.error)

    def get_source(self, address):
        self.record("getsourcecode", address)
        is_proxy = self.proxy and address.lower() != IMPL
        return [source_entry(is_proxy, [] if is_proxy else self.abi)]

    def get_abi(self, address):
        self.record("getabi", address)
        return self.abi

    def get_logs(self, address, from_block, to_block, page=1, offset=1000):
        self.record("getLogs", address, from_block, to_block, page, offset)
        value = self.pages[page - 1]
        if isinstance(value, Exception):
            raise value
        return value

    def get_receipt(self, tx_hash):
        self.record("eth_getTransactionReceipt", tx_hash)
        return self.receipt


class ProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = probe.load_source()
        cls.address = cls.source["routes"]["u"]["depositAggregator"]
        cls.event_map = probe.matching_events(fixture_abi(), cls.source)
        cls.dispatched = next(event for event in cls.event_map.values() if event["name"] == "AggregateDispatched")
        cls.finalized = next(event for event in cls.event_map.values() if event["name"] == "AggregateFinalized")

    def args(self, logs=False):
        return argparse.Namespace(route="u", role="deposit", from_block=100 if logs else None,
                                  to_block=110 if logs else None, page_size=1000, max_pages=3,
                                  max_requests=10, timeout=10, min_request_interval=0,
                                  receipt_sample=False)

    def event(self, index=0, *, block=100, topic=None, batch=9, block_hash=None):
        value = {"address": self.address, "blockNumber": hex(block), "logIndex": hex(index),
                 "transactionHash": TX, "topics": [topic or self.dispatched["topic0"]],
                 "data": "0x" + batch.to_bytes(32, "big").hex(), "sensitiveExtra": SENSITIVE}
        if block_hash:
            value["blockHash"] = block_hash
        return value

    def test_source_registry_is_bsc_and_does_not_guess_deployment_block(self):
        self.assertEqual(56, self.source["chainId"])
        self.assertEqual("56", self.source["explorerApi"]["chainIdParameter"])
        self.assertIsNone(self.source["deploymentBlock"])
        self.assertEqual(2, len(self.source["routes"]))

    def test_no_key_blocks_before_network_and_never_requests_wallet_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {}, clear=True), patch(
                "bsc_etherscan_probe.EtherscanClient._fetch") as fetch, redirect_stdout(io.StringIO()) as stdout:
            code = probe.main(["--output-dir", directory])
            reports = list(Path(directory).glob("*.json"))
            result = json.loads(reports[0].read_text())
        self.assertEqual(2, code)
        self.assertEqual("MISSING_OR_INVALID_API_KEY", result["stopReason"])
        self.assertEqual(0, result["requestCount"])
        self.assertEqual(56, result["chainId"])
        self.assertNotIn("private", stdout.getvalue().lower())
        fetch.assert_not_called()

    def test_default_metadata_only_never_calls_logs(self):
        client = FakeClient()
        result = probe.run_probe(self.args(), client, self.source)
        self.assertEqual("metadata_observed_logs_not_requested", result["status"])
        self.assertIsNone(result["batchEventCount"])
        self.assertEqual([("getsourcecode", self.address)], client.calls)
        self.assertNotIn(SENSITIVE, json.dumps(result))
        self.assertNotIn("SourceCode", json.dumps(result))
        self.assertEqual("not_established", result["productionReadiness"])

    def test_one_proxy_implementation_hop_resolves_batch_abi(self):
        client = FakeClient(proxy=True)
        result = probe.run_probe(self.args(), client, self.source)
        self.assertEqual("metadata_observed_logs_not_requested", result["status"])
        self.assertEqual([self.address, IMPL], [call[1] for call in client.calls])
        self.assertEqual(IMPL, result["implementationMetadata"]["address"])
        self.assertEqual(2, len(result["matchedCandidateEvents"]))

    def test_malformed_metadata_abi_uses_abi_endpoint_not_guess(self):
        client = FakeClient()
        with patch.object(client, "get_source", return_value=[{**source_entry(), "ABI": "invalid"}]):
            result = probe.run_probe(self.args(), client, self.source)
        self.assertEqual("metadata_observed_logs_not_requested", result["status"])
        self.assertEqual("getabi", client.calls[0][0])

    def test_unverified_or_nested_proxy_fails_closed(self):
        client = FakeClient()
        with patch.object(client, "get_source", return_value=[{**source_entry(), "SourceCode": ""}]):
            result = probe.run_probe(self.args(True), client, self.source)
        self.assertEqual("UNVERIFIED_CONTRACT", result["stopReason"])
        with patch.object(client, "get_source", return_value=[source_entry(proxy=True)]):
            result = probe.run_probe(self.args(True), client, self.source)
        self.assertEqual("NESTED_PROXY_UNRESOLVED", result["stopReason"])

    def test_candidates_absent_from_actual_abi_are_not_projected(self):
        self.assertEqual({}, probe.matching_events([], self.source))
        client = FakeClient()
        client.abi = []
        result = probe.run_probe(self.args(True), client, self.source)
        self.assertEqual("BATCH_EVENT_ABI_UNRESOLVED", result["stopReason"])
        self.assertFalse(any(call[0] == "getLogs" for call in client.calls))

    def test_full_page_followed_by_empty_page_completes_bounded_provider_scan(self):
        client = FakeClient([[self.event(0), self.event(1)], []])
        result = probe.scan_events(client, self.address, self.event_map, 100, 110, page_size=2)
        self.assertTrue(result["complete"])
        self.assertEqual(2, result["pagesFetched"])
        self.assertEqual(2, len(result["events"]))
        self.assertIsNone(result["events"][0]["blockHash"])
        self.assertEqual("provider_observed_unreviewed", result["events"][0]["finality"])
        self.assertEqual("9", result["events"][0]["batchId"])
        self.assertNotIn(SENSITIVE, json.dumps(result))
        self.assertNotIn("data", result["events"][0])

    def test_exact_full_page_at_budget_is_partial_not_zero_or_complete(self):
        client = FakeClient([[self.event()]])
        result = probe.scan_events(client, self.address, self.event_map, 100, 110, page_size=1, max_pages=1)
        self.assertFalse(result["complete"])
        self.assertEqual("PAGE_BUDGET_EXHAUSTED", result["stopReason"])

    def test_repeated_or_overlapping_pages_fail_closed(self):
        for pages, expected in [([[self.event()], [self.event()]], "REPEATED_PAGE"),
                                ([[self.event(0), self.event(1)], [self.event(1), self.event(2)]], "DUPLICATE_EVENT")]:
            with self.subTest(expected=expected):
                result = probe.scan_events(FakeClient(pages), self.address, self.event_map, 100, 110,
                                           page_size=len(pages[0]), max_pages=2)
                self.assertFalse(result["complete"])
                self.assertEqual(expected, result["stopReason"])

    def test_quota_or_missing_page_keeps_only_trustworthy_prefix(self):
        client = FakeClient([[self.event()], EtherscanError("RATE_LIMITED", retryable=True)])
        result = probe.scan_events(client, self.address, self.event_map, 100, 110, page_size=1)
        self.assertFalse(result["complete"])
        self.assertEqual("RATE_LIMITED", result["stopReason"])
        self.assertEqual(1, len(result["events"]))
        self.assertEqual(2, client.requests_made)

    def test_out_of_scope_or_conflicting_logs_are_not_counted(self):
        cases = [([self.event(block=111)], "LOG_OUTSIDE_REQUESTED_RANGE"),
                 ([{**self.event(), "address": IMPL}], "INVALID_LOG_RESPONSE"),
                 ([self.event(0, block_hash=BLOCK), self.event(1, block_hash="0x" + "ef" * 32)], "CONFLICTING_BLOCK_HASH"),
                 ([self.event(0, block=100), self.event(1, block=101)], "CONFLICTING_TRANSACTION_BLOCK")]
        for rows, expected in cases:
            with self.subTest(expected=expected):
                result = probe.scan_events(FakeClient([rows]), self.address, self.event_map, 100, 110)
                self.assertEqual(expected, result["stopReason"])
                self.assertEqual([], result["events"])

    def test_private_looking_unused_data_word_is_not_retained(self):
        # The ignored exchange-rate word is synthetic and deliberately opaque.
        event = self.event(topic=self.finalized["topic0"])
        event["data"] += b"PRIVATE_RATE_FIXTURE".ljust(32, b"\0").hex()
        result = probe.scan_events(FakeClient([[event]]), self.address, self.event_map, 100, 110)
        self.assertTrue(result["complete"])
        self.assertEqual("9", result["events"][0]["batchId"])
        self.assertNotIn(b"PRIVATE_RATE_FIXTURE".hex(), json.dumps(result))

    def test_verified_indexed_batch_id_location_is_used(self):
        event_map = probe.matching_events(fixture_abi(indexed=True), self.source)
        event = self.event()
        event["topics"].append(event["data"])
        event["data"] = "0x"
        result = probe.scan_events(FakeClient([[event]]), self.address, event_map, 100, 110)
        self.assertTrue(result["complete"])
        self.assertEqual("9", result["events"][0]["batchId"])

    def test_unknown_events_are_discarded_without_exposing_participant_data(self):
        event = self.event(topic="0x" + "ff" * 32)
        result = probe.scan_events(FakeClient([[event]]), self.address, self.event_map, 100, 110)
        self.assertTrue(result["complete"])
        self.assertEqual([], result["events"])
        self.assertNotIn(SENSITIVE, json.dumps(result))

    def test_receipt_reconciles_batch_id_and_block_hash(self):
        raw = self.event(block_hash=BLOCK)
        _, event = probe._event(raw, self.address, self.event_map, 100, 110)
        receipt = {"transactionHash": TX, "blockHash": BLOCK, "blockNumber": "0x64",
                   "status": "0x1", "logs": [raw]}
        result = probe.reconcile_receipt(receipt, event, self.dispatched)
        self.assertTrue(result["receiptEventMatch"])
        self.assertEqual("9", result["batchId"])
        raw["data"] = "0x" + (10).to_bytes(32, "big").hex()
        with self.assertRaises(EtherscanError) as caught:
            probe.reconcile_receipt(receipt, event, self.dispatched)
        self.assertEqual("RECEIPT_EVENT_MISMATCH", caught.exception.code)

    def test_log_flow_never_calls_native_private_state_or_apy(self):
        client = FakeClient([[self.event()]])
        result = probe.run_probe(self.args(True), client, self.source)
        self.assertEqual("bounded_batch_sample_observed", result["status"])
        self.assertEqual(1, result["batchEventCount"])
        self.assertEqual("not_queried", result["nativeBatchState"])
        self.assertEqual("not_queried", result["apy"])
        self.assertEqual("not_approved", result["publicationReview"])

    def test_partial_run_has_unknown_count_instead_of_fake_zero(self):
        client = FakeClient([EtherscanError("RATE_LIMITED")])
        result = probe.run_probe(self.args(True), client, self.source)
        self.assertEqual("partial", result["status"])
        self.assertIsNone(result["batchEventCount"])

    def test_cli_requires_both_bounded_block_arguments(self):
        for argv in [["--from-block", "100"], ["--to-block", "100"],
                     ["--from-block", "1", "--to-block", "10001"], ["--max-pages", "6"],
                     ["--max-requests", "21"], ["--page-size", "1001"]]:
            with self.subTest(argv=argv), redirect_stdout(io.StringIO()), patch("sys.stderr", io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    probe.arguments(argv)
                self.assertEqual(2, caught.exception.code)


if __name__ == "__main__":
    unittest.main()
