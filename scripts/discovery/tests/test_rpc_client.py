"""Offline transport contract tests; no real provider or network access."""

import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rpc_client import JsonRpcClient, RpcError


class RpcClientTests(unittest.TestCase):
    ENDPOINT = "https://rpc.example/secret-provider-key?token=private-value"

    def client(self, **kwargs):
        return JsonRpcClient(self.ENDPOINT, **kwargs)

    def reply(self, result="0x2105", *, status=200, connect=200, code=0, raw=None, headers=None):
        def run(command, **kwargs):
            request_path = Path(command[command.index("--data-binary") + 1][1:])
            request = json.loads(request_path.read_text())
            body = raw if raw is not None else json.dumps(
                {"jsonrpc": "2.0", "id": request["id"], "result": result}
            ).encode()
            Path(command[command.index("--output") + 1]).write_bytes(body)
            if headers is not None:
                Path(command[command.index("--dump-header") + 1]).write_bytes(headers)
            return SimpleNamespace(
                returncode=code,
                stdout=f"{status} {connect}".encode(),
                stderr=b"provider URL secret-provider-key private-value",
            )
        return run

    def assert_error(self, expected, client, method="eth_chainId", params=None):
        with self.assertRaises(RpcError) as caught:
            client.call(method, [] if params is None else params)
        self.assertEqual(expected, caught.exception.code)
        self.assertEqual(expected, str(caught.exception))
        return caught.exception

    @patch("rpc_client.subprocess.run")
    def test_success_is_read_only_and_secret_safe(self, run):
        run.side_effect = self.reply()
        client = self.client()
        self.assertEqual("0x2105", client.call("eth_chainId", []))
        command = run.call_args.args[0]
        config = run.call_args.kwargs["input"]
        self.assertNotIn(self.ENDPOINT, str(command))
        self.assertIn(self.ENDPOINT.encode(), config)
        self.assertEqual("rpc.example", client.endpoint_host)
        self.assertNotIn("secret-provider-key", json.dumps(client.events))
        self.assertNotIn("private-value", json.dumps(client.events))
        self.assertNotIn("--location", command)
        self.assertNotIn("--insecure", command)
        self.assertEqual("--disable", command[1])
        self.assertEqual("=https", command[command.index("--proto") + 1])
        self.assertEqual(10.25, run.call_args.kwargs["timeout"])
        self.assertFalse(Path(command[command.index("--output") + 1]).exists())
        self.assertEqual(1, client.requests_made)
        self.assertEqual("ok", client.events[0]["outcome"])

    @patch("rpc_client.subprocess.run")
    def test_request_budget_and_no_automatic_retry(self, run):
        run.side_effect = self.reply()
        client = self.client(max_requests=1)
        client.call("eth_chainId", [])
        self.assert_error("REQUEST_BUDGET_EXHAUSTED", client)
        self.assertEqual(1, run.call_count)
        self.assertEqual(1, client.requests_made)

    @patch("rpc_client.subprocess.run")
    def test_signing_and_unknown_methods_are_never_sent(self, run):
        client = self.client()
        for method in ["eth_sendRawTransaction", "personal_sign", "secret-method"]:
            self.assert_error("INVALID_METHOD", client, method)
        run.assert_not_called()
        self.assertEqual([], client.events)
        self.assertEqual(0, client.requests_made)

    @patch("rpc_client.subprocess.run")
    def test_invalid_and_oversized_params_are_not_sent(self, run):
        client = self.client()
        for params in [{}, [float("nan")], [object()]]:
            self.assert_error("INVALID_PARAMS", client, params=params)
        self.assert_error("REQUEST_TOO_LARGE", client, params=["x" * 256_001])
        run.assert_not_called()

    @patch("rpc_client.subprocess.run")
    def test_hard_subprocess_timeout_is_sanitized(self, run):
        run.side_effect = subprocess.TimeoutExpired("secret-provider-key", 1)
        client = self.client(timeout_seconds=1)
        error = self.assert_error("REQUEST_TIMEOUT", client)
        self.assertTrue(error.retryable)
        self.assertEqual(1, run.call_count)
        self.assertNotIn("secret", json.dumps(client.events))

    @patch("rpc_client.subprocess.run")
    def test_curl_timeout_and_size_exit_codes(self, run):
        for exit_code, expected in [(28, "REQUEST_TIMEOUT"), (63, "RESPONSE_TOO_LARGE")]:
            with self.subTest(exit_code=exit_code):
                run.side_effect = self.reply(status=0, connect=0, code=exit_code)
                self.assert_error(expected, self.client())

    @patch("rpc_client.subprocess.run")
    def test_tls_failures_remain_distinct_sanitized_and_not_retried(self, run):
        for exit_code, expected in [
            (51, "TLS_VERIFICATION_FAILED"),
            (60, "TLS_VERIFICATION_FAILED"),
            (77, "TLS_TRUST_CONFIGURATION_FAILED"),
            (35, "TLS_HANDSHAKE_FAILED"),
        ]:
            with self.subTest(exit_code=exit_code):
                run.side_effect = self.reply(status=0, connect=200, code=exit_code)
                client = self.client()
                error = self.assert_error(expected, client)
                self.assertFalse(error.retryable)
                self.assertEqual(1, client.requests_made)
                self.assertNotIn("private-value", json.dumps(client.events))
                command = run.call_args.args[0]
                self.assertNotIn("--insecure", command)

    @patch("rpc_client.subprocess.run")
    def test_proxy_denial_is_distinct_from_remote_http_denial(self, run):
        run.side_effect = self.reply(status=0, connect=403, code=56)
        error = self.assert_error("PROXY_TUNNEL_DENIED", self.client())
        self.assertEqual(403, error.http_status)
        run.side_effect = self.reply(status=403)
        error = self.assert_error("HTTP_FORBIDDEN", self.client())
        self.assertEqual(403, error.http_status)

    @patch("rpc_client.subprocess.run")
    def test_numeric_retry_after_comes_only_from_final_response(self, run):
        headers = (b"HTTP/1.1 200 Connection established\r\nRetry-After: 99\r\n"
                   b"Proxy-Secret: secret-provider-key\r\n\r\nHTTP/2 429\r\nretry-after: 7\r\n"
                   b"Sensitive: private-value\r\n\r\n")
        run.side_effect = self.reply(status=429, headers=headers)
        client = self.client()
        error = self.assert_error("RATE_LIMITED", client)
        self.assertEqual(429, error.http_status)
        self.assertEqual(7, error.retry_after_seconds)
        self.assertEqual(7, client.events[0]["retryAfterSeconds"])
        self.assertEqual(429, client.events[0]["httpStatus"])
        self.assertNotIn("private-value", json.dumps(client.events))
        self.assertNotIn("secret-provider-key", json.dumps(client.events))
        self.assertEqual(1, run.call_count)
        command = run.call_args.args[0]
        self.assertFalse(Path(command[command.index("--dump-header") + 1]).exists())

    @patch("rpc_client.subprocess.run")
    def test_date_invalid_duplicate_or_oversized_retry_after_is_ignored(self, run):
        cases = [
            b"HTTP/2 429\r\nRetry-After: Sun, 08 Nov 2026 19:30:00 GMT\r\n\r\n",
            b"HTTP/2 429\r\nRetry-After: -1\r\n\r\n",
            b"HTTP/2 429\r\nRetry-After: 1.5\r\n\r\n",
            b"HTTP/2 429\r\nRetry-After: 999999999999999999999999\r\n\r\n",
            b"HTTP/2 429\r\nRetry-After: 86401\r\n\r\n",
            b"HTTP/2 429\r\nRetry-After: 1\r\nRetry-After: 2\r\n\r\n",
            b"HTTP/2 429\r\nRetry-After: 1\r\nX-Large: " + b"x" * 65_536,
            b"HTTP/1.1 200 Connection established\r\nRetry-After: 8\r\n\r\nHTTP/2 429\r\n\r\n",
            b"HTTP/2 503\r\nRetry-After: 1\r\n\r\n",
        ]
        for headers in cases:
            with self.subTest(header_length=len(headers)):
                run.side_effect = self.reply(status=429, headers=headers)
                client = self.client()
                error = self.assert_error("RATE_LIMITED", client)
                self.assertIsNone(error.retry_after_seconds)
                self.assertNotIn("retryAfterSeconds", client.events[0])

    @patch("rpc_client.subprocess.run")
    def test_zero_retry_after_is_retained(self, run):
        run.side_effect = self.reply(status=429, headers=b"HTTP/2 429\r\nRetry-After: 0\r\n\r\n")
        error = self.assert_error("RATE_LIMITED", self.client())
        self.assertEqual(0, error.retry_after_seconds)

    @patch("rpc_client.subprocess.run")
    def test_rate_limit_server_error_and_redirect_are_not_retried(self, run):
        for status, expected in [(429, "RATE_LIMITED"), (503, "HTTP_SERVER_ERROR"), (302, "REDIRECT_REFUSED")]:
            with self.subTest(status=status):
                run.side_effect = self.reply(status=status)
                client = self.client()
                self.assert_error(expected, client)
                self.assertEqual(1, client.requests_made)

    @patch("rpc_client.subprocess.run")
    def test_response_size_is_rechecked_after_transport(self, run):
        run.side_effect = self.reply(raw=b"x" * 101)
        self.assert_error("RESPONSE_TOO_LARGE", self.client(max_response_bytes=100))

    @patch("rpc_client.subprocess.run")
    def test_malformed_envelopes_are_rejected(self, run):
        cases = [
            b"not JSON",
            b"<html>provider login</html>",
            b'[{"jsonrpc":"2.0","id":1,"result":0}]',
            b'{"jsonrpc":"1.0","id":1,"result":0}',
            b'{"jsonrpc":"2.0","id":2,"result":0}',
            b'{"jsonrpc":"2.0","id":true,"result":0}',
            b'{"jsonrpc":"2.0","id":1}',
            b'{"jsonrpc":"2.0","id":1,"result":0,"error":null}',
            b'{"jsonrpc":"2.0","id":1,"result":0,"result":1}',
            b'{"jsonrpc":"2.0","id":1,"result":NaN}',
            b'{"jsonrpc":"2.0","id":1,"error":{"code":true,"message":"bad"}}',
        ]
        for body in cases:
            with self.subTest(body=body):
                run.side_effect = self.reply(raw=body)
                self.assert_error("INVALID_RESPONSE", self.client())

    @patch("rpc_client.subprocess.run")
    def test_null_result_is_valid(self, run):
        run.side_effect = self.reply(result=None)
        self.assertIsNone(self.client().call("eth_getTransactionReceipt", ["0x123"]))

    @patch("rpc_client.subprocess.run")
    def test_rpc_error_metadata_never_contains_external_message(self, run):
        for message, code in [
            ("provider private-value failed", "RPC_ERROR"),
            ("too many requests secret-provider-key", "RATE_LIMITED"),
            ("block range too large private-value", "RPC_RANGE_LIMIT"),
        ]:
            with self.subTest(code=code):
                body = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32005, "message": message}}).encode()
                run.side_effect = self.reply(raw=body)
                client = self.client()
                error = self.assert_error(code, client)
                self.assertEqual(-32005, error.rpc_code)
                self.assertNotIn("private-value", json.dumps(client.events))
                self.assertNotIn("secret-provider-key", json.dumps(client.events))

    @patch("rpc_client.subprocess.run")
    def test_quota_exhaustion_never_requests_range_splitting(self, run):
        messages = [
            "daily request limit exceeded",
            "monthly credits exhausted",
            "Daily limit reached; reduce block range",
            "Insufficient credits for eth_getLogs",
            "Your request quota is depleted",
            "Compute units exceeded",
            "Request limit reached",
        ]
        for message in messages:
            with self.subTest(message=message):
                body = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32005, "message": message}}).encode()
                run.side_effect = self.reply(raw=body)
                client = self.client()
                self.assert_error("RATE_LIMITED", client, "eth_getLogs", [{}])
                self.assertEqual(1, client.requests_made)

    @patch("rpc_client.subprocess.run")
    def test_ambiguous_limit_error_is_not_a_range_limit(self, run):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32005, "message": "limit exceeded"}}).encode()
        run.side_effect = self.reply(raw=body)
        self.assert_error("RPC_ERROR", self.client(), "eth_getLogs", [{}])

    @patch("rpc_client.subprocess.run")
    def test_monotonic_request_ids(self, run):
        run.side_effect = self.reply()
        client = self.client()
        client.call("eth_chainId", [])
        client.call("eth_blockNumber", [])
        self.assertEqual(2, client.requests_made)
        self.assertEqual(2, len(client.events))

    def test_endpoint_and_limit_validation_does_not_disclose_values(self):
        for endpoint in ["http://rpc.example/private-value", "https://u:p@rpc.example", "https://rpc.example/#secret", "https://rpc.example/\nsecret", "https://rpc.example:bad"]:
            with self.subTest(endpoint=endpoint), self.assertRaises(RpcError) as caught:
                JsonRpcClient(endpoint)
            self.assertEqual("INVALID_ENDPOINT", str(caught.exception))
        for kwargs in [{"timeout_seconds": 0}, {"timeout_seconds": float("nan")}, {"max_requests": 0}, {"max_response_bytes": 10_000_001}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(RpcError) as caught:
                self.client(**kwargs)
            self.assertEqual("INVALID_LIMITS", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
