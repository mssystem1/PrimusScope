"""Bounded, read-only JSON-RPC transport for the discovery CLI.

No SDK, retry loop, provider account or signing key is required. curl inherits
the execution environment's proxy and CA trust. Endpoint paths/query strings,
request arguments, provider error messages and response bodies never enter
diagnostics. This is a feasibility helper, not a production indexer.
"""

from __future__ import annotations

import json
import math
import re
import re
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit


READ_METHODS = frozenset(
    {
        "eth_chainId",
        "eth_blockNumber",
        "eth_getCode",
        "eth_getStorageAt",
        "eth_getBlockByNumber",
        "eth_getTransactionReceipt",
        "eth_getLogs",
        "eth_call",
    }
)


class RpcError(Exception):
    """An intentionally sanitized transport/protocol failure."""

    def __init__(
        self, code: str, retryable: bool = False, rpc_code: int | None = None,
        http_status: int | None = None, retry_after_seconds: int | None = None,
    ) -> None:
        self.code = code
        self.retryable = retryable
        self.rpc_code = rpc_code
        self.http_status = http_status
        self.retry_after_seconds = retry_after_seconds
        super().__init__(code)


def _json_object(pairs: list[tuple[str, object]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("non-JSON numeric constant")


def _retry_after_seconds(path: Path, http_status: int) -> int | None:
    """Only bounded numeric Retry-After from the final HTTP response."""
    try:
        with path.open("rb") as header_file:
            raw = header_file.read(65_537)
    except OSError:
        return None
    if len(raw) > 65_536:
        return None
    status = None
    values: list[bytes] = []
    for line in raw.splitlines():
        if line.startswith(b"HTTP/"):
            parts = line.split(None, 2)
            status = int(parts[1]) if len(parts) >= 2 and re.fullmatch(rb"[0-9]{3}", parts[1]) else None
            values = []
        elif b":" in line:
            name, value = line.split(b":", 1)
            if name.lower() == b"retry-after":
                values.append(value.strip())
    if status != http_status or len(values) != 1 or not re.fullmatch(rb"[0-9]{1,6}", values[0]):
        return None
    seconds = int(values[0])
    return seconds if seconds <= 86_400 else None


class JsonRpcClient:
    def __init__(
        self,
        endpoint: str,
        timeout_seconds: float = 10,
        max_requests: int = 40,
        max_response_bytes: int = 2_000_000,
    ) -> None:
        try:
            parsed = urlsplit(endpoint)
            valid_endpoint = (
                isinstance(endpoint, str)
                and not any(ord(c) < 32 or ord(c) == 127 for c in endpoint)
                and parsed.scheme == "https"
                and bool(parsed.hostname)
                and not parsed.username
                and not parsed.password
                and not parsed.fragment
            )
            # Trigger validation for malformed ports without disclosing the URL.
            parsed.port
        except (ValueError, TypeError, AttributeError):
            valid_endpoint = False
        if not valid_endpoint:
            raise RpcError("INVALID_ENDPOINT")
        if (
            not isinstance(timeout_seconds, (int, float))
            or isinstance(timeout_seconds, bool)
            or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= 60
            or type(max_requests) is not int
            or not 1 <= max_requests <= 10_000
            or type(max_response_bytes) is not int
            or not 1 <= max_response_bytes <= 10_000_000
        ):
            raise RpcError("INVALID_LIMITS")
        self._endpoint = endpoint
        self.endpoint_host = parsed.hostname
        self.timeout_seconds = float(timeout_seconds)
        self.max_requests = max_requests
        self.max_response_bytes = max_response_bytes
        self.requests_made = 0
        self.events: list[dict] = []

    def call(self, method: str, params: list) -> object:
        # Do not record untrusted rejected method text or parameter contents.
        if not isinstance(method, str) or method not in READ_METHODS:
            raise RpcError("INVALID_METHOD")
        if not isinstance(params, list):
            raise RpcError("INVALID_PARAMS")
        if self.requests_made >= self.max_requests:
            raise RpcError("REQUEST_BUDGET_EXHAUSTED")
        request_id = self.requests_made + 1
        try:
            payload = json.dumps(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError, RecursionError):
            raise RpcError("INVALID_PARAMS") from None
        if len(payload) > 256_000:
            raise RpcError("REQUEST_TOO_LARGE")

        self.requests_made += 1
        started = time.monotonic()
        try:
            result = self._request(payload, request_id)
        except RpcError as exc:
            event = {
                "method": method,
                "elapsedMs": round((time.monotonic() - started) * 1000, 3),
                "outcome": exc.code,
                "retryable": exc.retryable,
            }
            if exc.rpc_code is not None:
                event["rpcCode"] = exc.rpc_code
            if exc.http_status is not None:
                event["httpStatus"] = exc.http_status
            if exc.retry_after_seconds is not None:
                event["retryAfterSeconds"] = exc.retry_after_seconds
            self.events.append(event)
            raise
        self.events.append(
            {
                "method": method,
                "elapsedMs": round((time.monotonic() - started) * 1000, 3),
                "outcome": "ok",
                "httpStatus": 200,
            }
        )
        return result

    def _request(self, payload: bytes, request_id: int) -> object:
        with tempfile.TemporaryDirectory(prefix="primusscope-rpc-") as directory:
            request_path = Path(directory) / "request.json"
            response_path = Path(directory) / "response.json"
            headers_path = Path(directory) / "response-headers.txt"
            request_path.write_bytes(payload)
            # TemporaryDirectory is private (0700); files are deleted on every
            # outcome. Passing the endpoint through stdin keeps keys out of argv.
            escaped_url = self._endpoint.replace("\\", "\\\\").replace('"', '\\"')
            config = f'url = "{escaped_url}"\n'.encode("utf-8")
            command = [
                "curl",
                "--disable",  # Do not load ~/.curlrc (redirects, TLS overrides).
                "--silent",
                "--show-error",
                "--proto",
                "=https",
                "--request",
                "POST",
                "--header",
                "Content-Type: application/json",
                "--connect-timeout",
                str(min(self.timeout_seconds, 5)),
                "--max-time",
                str(self.timeout_seconds),
                "--max-filesize",
                str(self.max_response_bytes),
                "--data-binary",
                "@" + str(request_path),
                "--output",
                str(response_path),
                "--dump-header",
                str(headers_path),
                "--write-out",
                "%{http_code} %{http_connect}",
                "--config",
                "-",
            ]
            try:
                completed = subprocess.run(
                    command,
                    input=config,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=self.timeout_seconds + 0.25,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                raise RpcError("REQUEST_TIMEOUT", retryable=True) from None
            except (OSError, ValueError):
                raise RpcError("TRANSPORT_UNAVAILABLE") from None

            # Never expose stderr: curl can include the endpoint or proxy URL.
            try:
                parts = completed.stdout.decode("ascii", errors="strict").split()
                if len(parts) != 2:
                    raise ValueError
                http_status, connect_status = (int(part) for part in parts)
            except (UnicodeError, ValueError, AttributeError):
                http_status, connect_status = 0, 0
            metadata = {
                "http_status": http_status if 100 <= http_status <= 599 else None,
                "retry_after_seconds": _retry_after_seconds(headers_path, http_status),
            }
            if connect_status == 403:
                raise RpcError("PROXY_TUNNEL_DENIED", http_status=403)
            if completed.returncode == 28:
                raise RpcError("REQUEST_TIMEOUT", retryable=True, **metadata)
            if completed.returncode == 63:
                raise RpcError("RESPONSE_TOO_LARGE", **metadata)
            if completed.returncode in (51, 60):
                raise RpcError("TLS_VERIFICATION_FAILED", **metadata)
            if completed.returncode == 77:
                raise RpcError("TLS_TRUST_CONFIGURATION_FAILED", **metadata)
            if completed.returncode == 35:
                raise RpcError("TLS_HANDSHAKE_FAILED", **metadata)
            if http_status == 429:
                raise RpcError("RATE_LIMITED", retryable=True, **metadata)
            if http_status == 403:
                raise RpcError("HTTP_FORBIDDEN", **metadata)
            if 300 <= http_status < 400:
                # Redirects are not followed, including same-host redirects.
                raise RpcError("REDIRECT_REFUSED", **metadata)
            if 500 <= http_status <= 599:
                raise RpcError("HTTP_SERVER_ERROR", retryable=True, **metadata)
            if completed.returncode:
                raise RpcError("TRANSPORT_ERROR", **metadata)
            if http_status != 200:
                raise RpcError("HTTP_ERROR", **metadata)
            try:
                with response_path.open("rb") as response_file:
                    body = response_file.read(self.max_response_bytes + 1)
            except OSError:
                raise RpcError("INVALID_RESPONSE", **metadata) from None
            if len(body) > self.max_response_bytes:
                raise RpcError("RESPONSE_TOO_LARGE", **metadata)

        try:
            response = json.loads(
                body.decode("utf-8"),
                object_pairs_hook=_json_object,
                parse_constant=_reject_constant,
            )
        except (ValueError, UnicodeError, RecursionError):
            raise RpcError("INVALID_RESPONSE", **metadata) from None
        if (
            not isinstance(response, dict)
            or response.get("jsonrpc") != "2.0"
            or type(response.get("id")) is not int
            or response["id"] != request_id
            or ("result" in response) == ("error" in response)
        ):
            raise RpcError("INVALID_RESPONSE", **metadata)
        if "error" in response:
            error = response["error"]
            if (
                not isinstance(error, dict)
                or type(error.get("code")) is not int
                or not isinstance(error.get("message"), str)
            ):
                raise RpcError("INVALID_RESPONSE", **metadata)
            rpc_code = error["code"]
            # Parse only for classification; never return/store external text.
            message = " ".join(error["message"].lower().split())
            budget_context = re.search(
                r"\b(daily|monthly|per[- ]day|per[- ]month|credits?|requests?|compute units?|quota)\b",
                message,
            )
            exhausted_budget = any(
                term in message
                for term in ("exceed", "exhaust", "reached", "insufficient", "depleted")
            )
            # Budget exhaustion must never trigger adaptive range splitting:
            # smaller ranges consume more calls without restoring the quota.
            if any(term in message for term in ("rate limit", "too many requests")) or (
                budget_context and exhausted_budget
            ) or any(
                term in message
                for term in ("daily limit", "monthly limit", "credit limit", "request limit")
            ):
                raise RpcError("RATE_LIMITED", retryable=True, rpc_code=rpc_code, **metadata)
            if any(
                term in message
                for term in (
                    "block range",
                    "too many results",
                    "response size",
                    "query returned more",
                    "range too large",
                )
            ):
                raise RpcError("RPC_RANGE_LIMIT", retryable=True, rpc_code=rpc_code, **metadata)
            raise RpcError("RPC_ERROR", rpc_code=rpc_code, **metadata)
        return response["result"]
