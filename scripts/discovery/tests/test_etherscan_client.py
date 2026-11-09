"""Offline BSC Etherscan discovery adapter checks; no provider key or network."""

import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from etherscan_client import EtherscanClient, EtherscanError


class EtherscanClientTests(unittest.TestCase):
    KEY = "synthetic-secret-key&chainid=1"
    ADDRESS = "0x" + "12" * 20
    TX = "0x" + "34" * 32

    def client(self, **kwargs):
        return EtherscanClient(self.KEY, min_interval_seconds=0, **kwargs)

    def reply(self, result=None, *, envelope=None, raw=None, status=200, connect=200, exit_code=0):
        response = envelope if envelope is not None else {"status": "1", "message": "OK", "result": result}

        def run(command, **kwargs):
            output = Path(command[command.index("--output") + 1])
            output.write_bytes(raw if raw is not None else json.dumps(response).encode())
            return SimpleNamespace(returncode=exit_code, stdout=f"{status} {connect}".encode(),
                                   stderr=("secret URL " + self.KEY).encode())
        return run

    def assert_error(self, code, action):
        with self.assertRaises(EtherscanError) as caught:
            action()
        self.assertEqual(code, caught.exception.code)
        self.assertEqual(code, str(caught.exception))
        self.assertNotIn(self.KEY, str(caught.exception))
        return caught.exception

    @patch("etherscan_client.subprocess.run")
    def test_key_missing_or_invalid_fails_before_io(self, run):
        for key in [None, "", " ", " key", "key\n", "x" * 4097]:
            with self.subTest(key_type=type(key).__name__):
                self.assert_error("MISSING_OR_INVALID_API_KEY", lambda: EtherscanClient(key))
        run.assert_not_called()

    @patch("etherscan_client.subprocess.run")
    def test_bsc_chain_fixed_and_key_only_enters_private_stdin(self, run):
        run.side_effect = self.reply(result=[{"ABI": "[]", "SourceCode": "public-code"}])
        client = self.client()
        source = client.get_source(self.ADDRESS)
        self.assertEqual("public-code", source[0]["SourceCode"])
        command = run.call_args.args[0]
        config = run.call_args.kwargs["input"].decode()
        url = config.split('"', 2)[1]
        query = parse_qs(urlsplit(url).query)
        self.assertEqual("https://api.etherscan.io/v2/api", url.split("?", 1)[0])
        self.assertEqual(["56"], query["chainid"])
        self.assertEqual([self.KEY], query["apikey"])
        self.assertEqual(["getsourcecode"], query["action"])
        self.assertNotIn(self.KEY, str(command))
        self.assertNotIn("apikey", str(command))
        self.assertNotIn(self.ADDRESS, json.dumps(client.events))
        self.assertNotIn(self.KEY, json.dumps(client.events))
        self.assertEqual("--disable", command[1])
        self.assertNotIn("--location", command)
        self.assertNotIn("--insecure", command)
        self.assertEqual("GET", command[command.index("--request") + 1])
        self.assertEqual("=https", command[command.index("--proto") + 1])
        self.assertEqual(10.25, run.call_args.kwargs["timeout"])
        self.assertFalse(Path(command[command.index("--output") + 1]).exists())

    @patch("etherscan_client.subprocess.run")
    def test_logs_pagination_fields_are_bounded_and_explicit(self, run):
        run.side_effect = self.reply(result=[{"public-event": True}])
        result = self.client().get_logs(self.ADDRESS, 100, 200, page=2, offset=100)
        self.assertEqual(1, len(result))
        config = run.call_args.kwargs["input"].decode()
        query = parse_qs(urlsplit(config.split('"', 2)[1]).query)
        self.assertEqual(["100"], query["fromBlock"])
        self.assertEqual(["200"], query["toBlock"])
        self.assertEqual(["2"], query["page"])
        self.assertEqual(["100"], query["offset"])

    @patch("etherscan_client.subprocess.run")
    def test_creation_metadata_is_scoped_and_projects_no_creator_or_bytecode(self, run):
        run.side_effect = self.reply(result=[{"contractAddress": self.ADDRESS, "txHash": self.TX,
            "blockNumber": "123", "timestamp": "1700000000", "contractCreator": "unneeded-wallet",
            "creationBytecode": "unneeded-bytecode"}])
        client = self.client()
        result = client.get_contract_creation([self.ADDRESS])
        self.assertEqual([{"contractAddress": self.ADDRESS, "transactionHash": self.TX,
                           "blockNumber": 123, "timestampUnix": "1700000000"}], result)
        query = parse_qs(urlsplit(run.call_args.kwargs["input"].decode().split('"', 2)[1]).query)
        self.assertEqual(["getcontractcreation"], query["action"])
        self.assertEqual([self.ADDRESS], query["contractaddresses"])
        self.assertNotIn("unneeded", json.dumps(result))
        self.assertNotIn(self.KEY, json.dumps(client.events))

    @patch("etherscan_client.subprocess.run")
    def test_creation_input_limits_and_duplicates_fail_before_io(self, run):
        client = self.client()
        for addresses in [[], [self.ADDRESS, self.ADDRESS.upper().replace("0X", "0x")],
                          ["0x" + format(i, "040x") for i in range(6)], self.ADDRESS]:
            self.assert_error("INVALID_QUERY_LIMITS", lambda: client.get_contract_creation(addresses))
        run.assert_not_called()

    @patch("etherscan_client.subprocess.run")
    def test_creation_incomplete_or_mismatched_provider_rows_fail(self, run):
        run.side_effect = self.reply(result=[])
        self.assert_error("INCOMPLETE_CREATION_METADATA", lambda: self.client().get_contract_creation([self.ADDRESS]))
        run.side_effect = self.reply(result=[{"contractAddress": "0x" + "ab" * 20,
            "txHash": self.TX, "blockNumber": "123", "timestamp": "1700000000"}])
        self.assert_error("INVALID_RESPONSE", lambda: self.client().get_contract_creation([self.ADDRESS]))

    @patch("etherscan_client.subprocess.run")
    def test_input_validation_never_makes_requests(self, run):
        client = self.client()
        for address in ["0xabc", "https://rpc.example/", "0x" + "gg" * 20, None]:
            self.assert_error("INVALID_ADDRESS", lambda: client.get_source(address))
        for start, end, page, offset in [(-1, 2, 1, 1), (2, 1, 1, 1), (0, 2, 0, 1),
                                          (0, 2, 1, 1001), (True, 2, 1, 1), (0, 2, True, 1)]:
            self.assert_error("INVALID_QUERY_LIMITS", lambda: client.get_logs(self.ADDRESS, start, end, page, offset))
        self.assert_error("INVALID_TRANSACTION_HASH", lambda: client.get_receipt("0xabc"))
        self.assert_error("INVALID_OPERATION", lambda: client._call("proxy", "eth_sendRawTransaction", {}))
        self.assertEqual(0, client.requests_made)
        self.assertEqual([], client.events)
        run.assert_not_called()

    @patch("etherscan_client.subprocess.run")
    def test_budget_has_no_retry_or_hidden_extra_request(self, run):
        run.side_effect = self.reply(result=[])
        client = self.client(max_requests=1)
        client.get_logs(self.ADDRESS, 0, 0)
        self.assert_error("REQUEST_BUDGET_EXHAUSTED", lambda: client.get_logs(self.ADDRESS, 0, 0))
        self.assertEqual(1, run.call_count)
        self.assertEqual(1, client.requests_made)

    @patch("etherscan_client.subprocess.run")
    def test_notok_error_classification_never_becomes_empty_logs(self, run):
        cases = [
            ("Max rate limit reached", "RATE_LIMITED"),
            ("Daily request limit reached", "RATE_LIMITED"),
            ("Invalid API Key " + self.KEY, "INVALID_API_KEY"),
            ("Free API access is not supported for this chain", "FREE_PLAN_CHAIN_UNSUPPORTED"),
            ("API Exclusive endpoint", "PLAN_RESTRICTED"),
            ("Contract source code not verified", "UNVERIFIED_CONTRACT"),
            ("Missing or unsupported chainid", "UNSUPPORTED_CHAIN"),
            ("Query timeout occurred", "QUERY_TIMEOUT"),
            ("Result window too large", "RESULT_RANGE_TOO_LARGE"),
            ("Unknown service problem " + self.KEY, "API_ERROR"),
        ]
        for message, expected in cases:
            with self.subTest(expected=expected):
                run.side_effect = self.reply(envelope={"status": "0", "message": "NOTOK", "result": message})
                client = self.client()
                self.assert_error(expected, lambda: client.get_logs(self.ADDRESS, 0, 100))
                self.assertEqual(expected, client.events[0]["outcome"])
                self.assertNotIn(self.KEY, json.dumps(client.events))

    @patch("etherscan_client.subprocess.run")
    def test_only_recognized_logs_no_records_envelope_is_empty(self, run):
        for result in [[], "", "No records found"]:
            run.side_effect = self.reply(envelope={"status": "0", "message": "No records found", "result": result})
            self.assertEqual([], self.client().get_logs(self.ADDRESS, 0, 10))
        run.side_effect = self.reply(envelope={"status": "0", "message": "NOTOK", "result": []})
        self.assert_error("API_ERROR", lambda: self.client().get_logs(self.ADDRESS, 0, 10))
        run.side_effect = self.reply(envelope={"status": "0", "message": "No records found", "result": []})
        self.assert_error("NOT_FOUND", lambda: self.client().get_abi(self.ADDRESS))

    @patch("etherscan_client.subprocess.run")
    def test_log_page_cap_is_not_silently_accepted(self, run):
        run.side_effect = self.reply(result=[{}, {}])
        client = self.client()
        self.assert_error("RESULT_LIMIT_VIOLATION", lambda: client.get_logs(self.ADDRESS, 0, 1, offset=1))
        self.assertEqual("RESULT_LIMIT_VIOLATION", client.events[-1]["outcome"])

    @patch("etherscan_client.subprocess.run")
    def test_parsed_abi_and_unverified_metadata(self, run):
        abi = [{"type": "function", "name": "aggregateState", "stateMutability": "view"}]
        run.side_effect = self.reply(result=json.dumps(abi))
        self.assertEqual(abi, self.client().get_abi(self.ADDRESS))
        run.side_effect = self.reply(result=[{"ABI": "Contract source code not verified", "SourceCode": ""}])
        self.assert_error("UNVERIFIED_CONTRACT", lambda: self.client().get_source(self.ADDRESS))
        run.side_effect = self.reply(result="malformed " + self.KEY)
        client = self.client()
        self.assert_error("INVALID_RESPONSE", lambda: client.get_abi(self.ADDRESS))
        self.assertEqual("INVALID_RESPONSE", client.events[-1]["outcome"])

    @patch("etherscan_client.subprocess.run")
    def test_incomplete_source_metadata_does_not_look_verified(self, run):
        for result in [[], [{}], [{"ABI": "[]"}], [{"ABI": [], "SourceCode": "public"}]]:
            with self.subTest(result=result):
                run.side_effect = self.reply(result=result)
                client = self.client()
                self.assert_error("INVALID_RESPONSE", lambda: client.get_source(self.ADDRESS))
                self.assertEqual("INVALID_RESPONSE", client.events[-1]["outcome"])

    @patch("etherscan_client.subprocess.run")
    def test_proxy_block_number_and_pending_receipt(self, run):
        run.side_effect = self.reply(envelope={"jsonrpc": "2.0", "id": 83, "result": "0x10"})
        self.assertEqual(16, self.client().get_block_number())
        run.side_effect = self.reply(envelope={"jsonrpc": "2.0", "id": 1, "result": None})
        self.assertIsNone(self.client().get_receipt(self.TX))

    @patch("etherscan_client.subprocess.run")
    def test_block_by_timestamp_uses_documented_bsc_read_and_decimal_result(self, run):
        run.side_effect = self.reply(result="123456789")
        client = self.client()
        self.assertEqual(123456789, client.get_block_by_time(1794153600, closest="after"))
        config = run.call_args.kwargs["input"].decode()
        query = parse_qs(urlsplit(config.split('"', 2)[1]).query)
        self.assertEqual(["56"], query["chainid"])
        self.assertEqual(["block"], query["module"])
        self.assertEqual(["getblocknobytime"], query["action"])
        self.assertEqual(["1794153600"], query["timestamp"])
        self.assertEqual(["after"], query["closest"])
        self.assertEqual("block", client.events[0]["module"])
        self.assertEqual("getblocknobytime", client.events[0]["action"])
        self.assertNotIn(self.KEY, json.dumps(client.events))

    @patch("etherscan_client.subprocess.run")
    def test_block_by_timestamp_defaults_to_before_and_accepts_genesis(self, run):
        run.side_effect = self.reply(result="0")
        self.assertEqual(0, self.client().get_block_by_time(0))
        config = run.call_args.kwargs["input"].decode()
        query = parse_qs(urlsplit(config.split('"', 2)[1]).query)
        self.assertEqual(["before"], query["closest"])

    @patch("etherscan_client.subprocess.run")
    def test_block_by_timestamp_rejects_invalid_query_before_io(self, run):
        client = self.client()
        for timestamp in [-1, True, "1794153600", 1.5, 2**63, None]:
            with self.subTest(timestamp=timestamp):
                self.assert_error("INVALID_QUERY_LIMITS", lambda: client.get_block_by_time(timestamp))
        for closest in ["latest", "Before", "", None, [], 1]:
            with self.subTest(closest=closest):
                self.assert_error("INVALID_CLOSEST", lambda: client.get_block_by_time(1, closest))
        self.assertEqual(0, client.requests_made)
        run.assert_not_called()

    @patch("etherscan_client.subprocess.run")
    def test_block_by_timestamp_rejects_malformed_or_unbounded_result(self, run):
        for result in [None, 1, True, "0x10", "-1", "01", " 1", "1.0", str(2**64), "9" * 100]:
            with self.subTest(result=result):
                run.side_effect = self.reply(result=result)
                client = self.client()
                self.assert_error("INVALID_RESPONSE", lambda: client.get_block_by_time(1))
                self.assertEqual("INVALID_RESPONSE", client.events[-1]["outcome"])

    @patch("etherscan_client.subprocess.run")
    def test_block_time_endpoint_plan_error_remains_scoped_in_ledger(self, run):
        run.side_effect = self.reply(envelope={"status": "0", "message": "NOTOK",
            "result": "Free API access is not supported for this chain"})
        client = self.client()
        self.assert_error("FREE_PLAN_CHAIN_UNSUPPORTED", lambda: client.get_block_by_time(1))
        self.assertEqual("block", client.events[-1]["module"])
        self.assertEqual("getblocknobytime", client.events[-1]["action"])
        self.assertEqual(1, client.requests_made)

    @patch("etherscan_client.subprocess.run")
    def test_receipt_identity_validation_and_payload_not_in_ledger(self, run):
        receipt = {"transactionHash": self.TX, "blockHash": "0x" + "56" * 32,
                   "blockNumber": "0x10", "logs": [{"data": "private-looking-fixture"}]}
        run.side_effect = self.reply(envelope={"jsonrpc": "2.0", "id": 1, "result": receipt})
        client = self.client()
        self.assertEqual(receipt, client.get_receipt(self.TX))
        self.assertNotIn("private-looking-fixture", json.dumps(client.events))
        receipt["transactionHash"] = "0x" + "78" * 32
        run.side_effect = self.reply(envelope={"jsonrpc": "2.0", "id": 1, "result": receipt})
        self.assert_error("INVALID_RESPONSE", lambda: self.client().get_receipt(self.TX))

    @patch("etherscan_client.subprocess.run")
    def test_malformed_envelopes_and_quantities_are_rejected(self, run):
        malformed = [
            b"<html>error</html>", b"[]", b'{"status":"1","status":"0","message":"OK","result":[]}',
            b'{"status":"1","message":"OK","result":NaN}',
            b'{"jsonrpc":"2.0","id":true,"result":"0x1"}',
            b'{"jsonrpc":"2.0","id":1,"result":"0x1","error":{}}',
            b'{"jsonrpc":"2.0","id":1,"error":{"code":"bad","message":"bad"}}',
            b'{"jsonrpc":"2.0","id":1,"result":"0x01"}',
        ]
        for raw in malformed:
            with self.subTest(raw_start=raw[:20]):
                run.side_effect = self.reply(raw=raw)
                client = self.client()
                self.assert_error("INVALID_RESPONSE", client.get_block_number)
                self.assertEqual("INVALID_RESPONSE", client.events[-1]["outcome"])

    @patch("etherscan_client.subprocess.run")
    def test_proxy_jsonrpc_error_is_not_a_null_receipt(self, run):
        run.side_effect = self.reply(envelope={"jsonrpc": "2.0", "id": 1,
                                              "error": {"code": -32011, "message": "request limit reached"}})
        self.assert_error("RATE_LIMITED", lambda: self.client().get_receipt(self.TX))

    @patch("etherscan_client.subprocess.run")
    def test_hard_timeout_and_response_size_bounds(self, run):
        run.side_effect = subprocess.TimeoutExpired("secret " + self.KEY, 1)
        client = self.client(timeout_seconds=1)
        self.assert_error("REQUEST_TIMEOUT", client.get_block_number)
        self.assertEqual(1, client.requests_made)
        run.side_effect = self.reply(raw=b"x" * 101)
        self.assert_error("RESPONSE_TOO_LARGE", self.client(max_response_bytes=100).get_block_number)

    @patch("etherscan_client.subprocess.run")
    def test_http_proxy_tls_and_redirect_errors_are_safe_and_not_retried(self, run):
        cases = [
            ({"status": 0, "connect": 403, "exit_code": 56}, "PROXY_TUNNEL_DENIED"),
            ({"status": 429}, "RATE_LIMITED"), ({"status": 403}, "HTTP_FORBIDDEN"),
            ({"status": 302}, "REDIRECT_REFUSED"), ({"status": 503}, "HTTP_SERVER_ERROR"),
            ({"status": 0, "exit_code": 60}, "TLS_VERIFICATION_FAILED"),
            ({"status": 0, "exit_code": 77}, "TLS_CONFIGURATION_FAILED"),
            ({"status": 0, "exit_code": 28}, "REQUEST_TIMEOUT"),
            ({"status": 0, "exit_code": 63}, "RESPONSE_TOO_LARGE"),
        ]
        for kwargs, expected in cases:
            with self.subTest(expected=expected):
                run.reset_mock()
                run.side_effect = self.reply(**kwargs)
                client = self.client()
                self.assert_error(expected, client.get_block_number)
                self.assertEqual(1, run.call_count)
                self.assertEqual(1, client.requests_made)
                self.assertNotIn(self.KEY, json.dumps(client.events))

    def test_limits_reject_nonfinite_bool_and_unbounded_values(self):
        cases = [{"timeout_seconds": float("nan")}, {"timeout_seconds": True}, {"timeout_seconds": 61},
                 {"max_requests": True}, {"max_requests": 0}, {"min_interval_seconds": float("inf")},
                 {"max_response_bytes": 10_000_001}]
        for options in cases:
            with self.subTest(options=options):
                self.assert_error("INVALID_LIMITS", lambda: EtherscanClient(self.KEY, **options))

    @patch("etherscan_client.subprocess.run")
    def test_pacing_spaces_calls_but_does_not_retry(self, run):
        run.side_effect = self.reply(result=[])
        now = [0.0]
        client = EtherscanClient(self.KEY, min_interval_seconds=2)
        with patch("etherscan_client.time.monotonic", side_effect=lambda: now[0]), patch(
                "etherscan_client.time.sleep", side_effect=lambda delay: now.__setitem__(0, now[0] + delay)) as sleep:
            client.get_logs(self.ADDRESS, 0, 1)
            client.get_logs(self.ADDRESS, 0, 1)
        sleep.assert_called_once_with(2)
        self.assertEqual(2, run.call_count)
        self.assertEqual(2, client.requests_made)


if __name__ == "__main__":
    unittest.main()
