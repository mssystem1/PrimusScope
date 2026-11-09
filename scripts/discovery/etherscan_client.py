"""Bounded Etherscan V2 reads for BSC discovery; no signing or public API proxy.

The API key travels only in curl's private stdin configuration, never argv or
diagnostics. TLS/proxy settings are inherited, redirects are refused, and no
automatic retries or paid fallback are implemented. Returned public source/log
payloads must still pass the caller's publication and completeness checks.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urlencode


_BASE_URL = "https://api.etherscan.io/v2/api"
_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
_HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
_QUANTITY = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_OPERATIONS = frozenset({
    ("contract", "getsourcecode"), ("contract", "getabi"),
    ("contract", "getcontractcreation"),
    ("logs", "getLogs"), ("proxy", "eth_getTransactionReceipt"),
    ("proxy", "eth_blockNumber"),
    ("block", "getblocknobytime"),
})


class EtherscanError(Exception):
    """Safe symbolic error; external messages and URLs are never retained."""

    def __init__(self, code: str, retryable: bool = False, http_status: int | None = None):
        self.code = code
        self.retryable = retryable
        self.http_status = http_status
        super().__init__(code)


def _object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("non-JSON numeric constant")


def _address(value: object) -> str:
    if not isinstance(value, str) or not _ADDRESS.fullmatch(value):
        raise EtherscanError("INVALID_ADDRESS")
    return value


def _number(value: object, *, minimum: int = 0, maximum: int = 2**64 - 1) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise EtherscanError("INVALID_QUERY_LIMITS")
    return value


def _quantity(value: object) -> int:
    if not isinstance(value, str) or len(value) > 66 or not _QUANTITY.fullmatch(value):
        raise EtherscanError("INVALID_RESPONSE")
    return int(value, 16)


def _api_error(message: object, result: object) -> EtherscanError:
    # Inspect only for classification; external text must not enter the error.
    fragments = [message] if isinstance(message, str) else []
    if isinstance(result, str):
        fragments.append(result)
    elif isinstance(result, dict) and isinstance(result.get("message"), str):
        fragments.append(result["message"])
    text = " ".join(fragments).lower()
    if any(term in text for term in ("rate limit", "too many requests", "quota exceeded")) or (
        "limit" in text and any(term in text for term in ("request", "daily", "monthly", "credit"))
    ):
        return EtherscanError("RATE_LIMITED", retryable=True)
    if any(term in text for term in ("invalid api key", "missing api key", "invalid apikey", "api key invalid")):
        return EtherscanError("INVALID_API_KEY")
    if "free" in text and any(term in text for term in ("not supported", "unsupported", "not available")):
        return EtherscanError("FREE_PLAN_CHAIN_UNSUPPORTED")
    if any(term in text for term in ("api exclusive", "pro endpoint", "requires a paid", "paid plan")):
        return EtherscanError("PLAN_RESTRICTED")
    if "not verified" in text or "not been verified" in text:
        return EtherscanError("UNVERIFIED_CONTRACT")
    if any(term in text for term in ("invalid chainid", "unsupported chain", "missing or unsupported chainid")):
        return EtherscanError("UNSUPPORTED_CHAIN")
    if any(term in text for term in ("query timeout", "query timed out", "timeout occurred")):
        return EtherscanError("QUERY_TIMEOUT", retryable=True)
    if any(term in text for term in ("too many records", "too many results", "result window", "range too large")):
        return EtherscanError("RESULT_RANGE_TOO_LARGE", retryable=True)
    if "no records found" in text:
        return EtherscanError("NOT_FOUND")
    return EtherscanError("API_ERROR")


class EtherscanClient:
    chain_id = 56
    endpoint_host = "api.etherscan.io"

    def __init__(
        self, api_key: str, timeout_seconds: float = 10, max_requests: int = 30,
        min_interval_seconds: float = 1, max_response_bytes: int = 2_000_000,
    ):
        if (not isinstance(api_key, str) or not api_key.strip() or len(api_key) > 4096
                or api_key != api_key.strip() or any(ord(c) < 32 or ord(c) == 127 for c in api_key)):
            raise EtherscanError("MISSING_OR_INVALID_API_KEY")
        if (not isinstance(timeout_seconds, (int, float)) or isinstance(timeout_seconds, bool)
                or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 60
                or type(max_requests) is not int or not 1 <= max_requests <= 1000
                or not isinstance(min_interval_seconds, (int, float)) or isinstance(min_interval_seconds, bool)
                or not math.isfinite(min_interval_seconds) or not 0 <= min_interval_seconds <= 60
                or type(max_response_bytes) is not int or not 1 <= max_response_bytes <= 10_000_000):
            raise EtherscanError("INVALID_LIMITS")
        self._api_key = api_key
        self.timeout_seconds = float(timeout_seconds)
        self.max_requests = max_requests
        self.min_interval_seconds = float(min_interval_seconds)
        self.max_response_bytes = max_response_bytes
        self.requests_made = 0
        self.events: list[dict] = []
        self._last_start: float | None = None

    def get_source(self, address: str) -> list[dict]:
        return self._call("contract", "getsourcecode", {"address": _address(address)})

    def get_abi(self, address: str) -> list[dict]:
        return self._call("contract", "getabi", {"address": _address(address)})

    def get_contract_creation(self, addresses: list[str]) -> list[dict]:
        if (not isinstance(addresses, list) or not 1 <= len(addresses) <= 5
                or len({str(v).lower() for v in addresses}) != len(addresses)):
            raise EtherscanError("INVALID_QUERY_LIMITS")
        return self._call("contract", "getcontractcreation", {
            "contractaddresses": ",".join(_address(value) for value in addresses)})

    def get_logs(self, address: str, from_block: int, to_block: int, page: int = 1, offset: int = 1000) -> list[dict]:
        _address(address)
        _number(from_block)
        _number(to_block)
        _number(page, minimum=1, maximum=10_000)
        _number(offset, minimum=1, maximum=1000)
        if from_block > to_block:
            raise EtherscanError("INVALID_QUERY_LIMITS")
        return self._call("logs", "getLogs", {
            "address": address, "fromBlock": str(from_block), "toBlock": str(to_block),
            "page": str(page), "offset": str(offset),
        })

    def get_receipt(self, tx_hash: str) -> dict | None:
        if not isinstance(tx_hash, str) or not _HASH.fullmatch(tx_hash):
            raise EtherscanError("INVALID_TRANSACTION_HASH")
        return self._call("proxy", "eth_getTransactionReceipt", {"txhash": tx_hash})

    def get_block_number(self) -> int:
        return self._call("proxy", "eth_blockNumber", {})

    def get_block_by_time(self, timestamp: int, closest: str = "before") -> int:
        """Resolve Unix seconds with Etherscan's block/getblocknobytime read.

        Its plan access is independent of the proxy/eth_blockNumber endpoint.
        The returned block is a provider observation, not a finality claim.
        """
        _number(timestamp, maximum=2**63 - 1)
        if not isinstance(closest, str) or closest not in {"before", "after"}:
            raise EtherscanError("INVALID_CLOSEST")
        return self._call("block", "getblocknobytime", {"timestamp": str(timestamp), "closest": closest})

    def _call(self, module: str, action: str, params: dict[str, str]) -> object:
        if (module, action) not in _OPERATIONS:
            raise EtherscanError("INVALID_OPERATION")
        if self.requests_made >= self.max_requests:
            raise EtherscanError("REQUEST_BUDGET_EXHAUSTED")
        if self._last_start is not None:
            wait = self._last_start + self.min_interval_seconds - time.monotonic()
            if wait > 0:
                time.sleep(wait)
        self._last_start = time.monotonic()
        self.requests_made += 1
        started = time.monotonic()
        try:
            response = self._fetch(module, action, params)
            result = self._interpret(response, module, action)
            result = self._validate_result(result, module, action, params)
        except EtherscanError as error:
            event = {"module": module, "action": action, "elapsedMs": round((time.monotonic() - started) * 1000, 3),
                     "outcome": error.code, "retryable": error.retryable}
            if error.http_status is not None:
                event["httpStatus"] = error.http_status
            self.events.append(event)
            raise
        self.events.append({"module": module, "action": action,
                            "elapsedMs": round((time.monotonic() - started) * 1000, 3), "outcome": "ok"})
        return result

    def _fetch(self, module: str, action: str, params: dict[str, str]) -> dict:
        query = {"chainid": str(self.chain_id), "module": module, "action": action,
                 **params, "apikey": self._api_key}
        url = _BASE_URL + "?" + urlencode(query)
        # URL encoding eliminates config newlines; escaping covers remaining
        # curl config syntax without putting any credential in process argv.
        config = ('url = "' + url.replace("\\", "\\\\").replace('"', '\\"') + '"\n').encode()
        with tempfile.TemporaryDirectory(prefix="primusscope-etherscan-") as directory:
            output = Path(directory) / "response.json"
            command = ["curl", "--disable", "--silent", "--show-error", "--proto", "=https",
                       "--request", "GET", "--header", "Accept: application/json",
                       "--user-agent", "PrimusScope-Discovery/0.1",
                       "--connect-timeout", str(min(self.timeout_seconds, 5)),
                       "--max-time", str(self.timeout_seconds), "--max-filesize", str(self.max_response_bytes),
                       "--output", str(output), "--write-out", "%{http_code} %{http_connect}", "--config", "-"]
            try:
                completed = subprocess.run(command, input=config, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           timeout=self.timeout_seconds + 0.25, check=False)
            except subprocess.TimeoutExpired:
                raise EtherscanError("REQUEST_TIMEOUT", retryable=True) from None
            except OSError:
                raise EtherscanError("TRANSPORT_UNAVAILABLE") from None
            try:
                parts = completed.stdout.decode("ascii").split()
                if len(parts) != 2:
                    raise ValueError
                status, connect = (int(item) for item in parts)
            except (ValueError, UnicodeError, AttributeError):
                status, connect = 0, 0
            # Do not expose curl stderr, header text or an error response body.
            if connect == 403:
                raise EtherscanError("PROXY_TUNNEL_DENIED", http_status=403)
            if completed.returncode == 28:
                raise EtherscanError("REQUEST_TIMEOUT", retryable=True)
            if completed.returncode == 63:
                raise EtherscanError("RESPONSE_TOO_LARGE")
            if completed.returncode in (51, 60):
                raise EtherscanError("TLS_VERIFICATION_FAILED")
            if completed.returncode in (35, 77):
                raise EtherscanError("TLS_CONFIGURATION_FAILED")
            if status == 429:
                raise EtherscanError("RATE_LIMITED", retryable=True, http_status=status)
            if status == 403:
                raise EtherscanError("HTTP_FORBIDDEN", http_status=status)
            if 300 <= status < 400:
                raise EtherscanError("REDIRECT_REFUSED", http_status=status)
            if 500 <= status < 600:
                raise EtherscanError("HTTP_SERVER_ERROR", retryable=True, http_status=status)
            if completed.returncode:
                raise EtherscanError("TRANSPORT_ERROR")
            if status != 200:
                raise EtherscanError("HTTP_ERROR", http_status=status or None)
            try:
                with output.open("rb") as file:
                    body = file.read(self.max_response_bytes + 1)
            except OSError:
                raise EtherscanError("INVALID_RESPONSE") from None
            if len(body) > self.max_response_bytes:
                raise EtherscanError("RESPONSE_TOO_LARGE")
        try:
            response = json.loads(body.decode("utf-8"), object_pairs_hook=_object, parse_constant=_reject_constant)
        except (ValueError, UnicodeError, RecursionError):
            raise EtherscanError("INVALID_RESPONSE") from None
        if not isinstance(response, dict):
            raise EtherscanError("INVALID_RESPONSE")
        return response

    @staticmethod
    def _validate_result(result: object, module: str, action: str, params: dict[str, str]) -> object:
        if (module, action) == ("contract", "getsourcecode"):
            if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
                raise EtherscanError("INVALID_RESPONSE")
            abi = result[0].get("ABI")
            if not isinstance(abi, str) or not isinstance(result[0].get("SourceCode"), str):
                raise EtherscanError("INVALID_RESPONSE")
            if isinstance(abi, str) and ("not verified" in abi.lower() or "not been verified" in abi.lower()):
                raise EtherscanError("UNVERIFIED_CONTRACT")
        elif (module, action) == ("contract", "getabi"):
            if not isinstance(result, str):
                raise EtherscanError("INVALID_RESPONSE")
            try:
                result = json.loads(result, object_pairs_hook=_object, parse_constant=_reject_constant)
            except (ValueError, RecursionError):
                raise EtherscanError("INVALID_RESPONSE") from None
            if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
                raise EtherscanError("INVALID_RESPONSE")
        elif (module, action) == ("contract", "getcontractcreation"):
            expected = {value.lower() for value in params["contractaddresses"].split(",")}
            if not isinstance(result, list) or len(result) != len(expected):
                raise EtherscanError("INCOMPLETE_CREATION_METADATA")
            projected, seen = [], set()
            for row in result:
                if not isinstance(row, dict):
                    raise EtherscanError("INVALID_RESPONSE")
                address = _address(row.get("contractAddress")).lower()
                block, stamp = row.get("blockNumber"), row.get("timestamp")
                if (address not in expected or address in seen
                        or not _HASH.fullmatch(str(row.get("txHash", "")))
                        or not isinstance(block, str) or not re.fullmatch(r"[0-9]{1,20}", block)
                        or not isinstance(stamp, str) or not re.fullmatch(r"[0-9]{1,20}", stamp)
                        or int(block) >= 2**64 or int(stamp) >= 2**64):
                    raise EtherscanError("INVALID_RESPONSE")
                seen.add(address)
                projected.append({"contractAddress": address, "transactionHash": row["txHash"].lower(),
                                  "blockNumber": int(block), "timestampUnix": str(int(stamp))})
            return projected
        elif (module, action) == ("logs", "getLogs"):
            if not isinstance(result, list) or any(not isinstance(row, dict) for row in result):
                raise EtherscanError("INVALID_RESPONSE")
            if len(result) > int(params["offset"]):
                raise EtherscanError("RESULT_LIMIT_VIOLATION")
        elif (module, action) == ("proxy", "eth_getTransactionReceipt"):
            if result is None:
                return None
            if (not isinstance(result, dict)
                    or str(result.get("transactionHash", "")).lower() != params["txhash"].lower()
                    or not _HASH.fullmatch(str(result.get("blockHash", "")))
                    or not isinstance(result.get("logs"), list)):
                raise EtherscanError("INVALID_RESPONSE")
            _quantity(result.get("blockNumber"))
        elif (module, action) == ("proxy", "eth_blockNumber"):
            return _quantity(result)
        elif (module, action) == ("block", "getblocknobytime"):
            if (not isinstance(result, str) or len(result) > 20 or not _DECIMAL.fullmatch(result)
                    or int(result) > 2**64 - 1):
                raise EtherscanError("INVALID_RESPONSE")
            return int(result)
        else:
            raise EtherscanError("INVALID_OPERATION")
        return result

    @staticmethod
    def _interpret(response: dict, module: str, action: str) -> object:
        if "status" in response:
            status, message, result = response.get("status"), response.get("message"), response.get("result")
            if status == "0":
                # Only the documented logs empty envelope becomes an empty
                # list. NOTOK with arbitrary text must never become fake zero.
                if (module == "logs" and action == "getLogs" and isinstance(message, str)
                        and message.lower() == "no records found"
                        and (result == [] or result == "" or (isinstance(result, str) and result.lower() == "no records found"))):
                    return []
                raise _api_error(message, result)
            if status != "1" or not isinstance(message, str) or message.lower() != "ok" or "result" not in response:
                if isinstance(message, str) and ("invalid" in message.lower() or "missing" in message.lower()):
                    raise _api_error(message, result)
                raise EtherscanError("INVALID_RESPONSE")
            return result
        response_id = response.get("id")
        valid_id = type(response_id) is int or (isinstance(response_id, str) and 0 < len(response_id) <= 64)
        if module != "proxy" or response.get("jsonrpc") != "2.0" or not valid_id:
            raise EtherscanError("INVALID_RESPONSE")
        if ("result" in response) == ("error" in response):
            raise EtherscanError("INVALID_RESPONSE")
        if "error" in response:
            if (not isinstance(response["error"], dict) or type(response["error"].get("code")) is not int
                    or not isinstance(response["error"].get("message"), str)):
                raise EtherscanError("INVALID_RESPONSE")
            raise _api_error(None, response["error"])
        return response["result"]
