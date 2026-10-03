"""Verify a Wayza signed answer (CONTRACT.md, "The signed answer")."""

from __future__ import annotations

import base64
import json
import threading
import time
import urllib.request
from typing import Any, Callable
from urllib.parse import urlparse

from ._errors import WayzaError, WayzaVerifyError
from ._util import canonical

KeyFetcher = Callable[[str], dict]

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_CACHE_SECONDS = 600


def _b64decode(text: str, urlsafe: bool) -> bytes:
    pad = "=" * (-len(text) % 4)
    return (base64.urlsafe_b64decode if urlsafe else base64.b64decode)(text + pad)


def fetch_well_known(origin: str, timeout: float = 10.0) -> dict:
    """GET {origin}/.well-known/wayza.json (cached for ten minutes)."""
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(origin)
        if hit and now - hit[0] < _CACHE_SECONDS:
            return hit[1]
    req = urllib.request.Request(origin + "/.well-known/wayza.json", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            doc = json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 - surfaced as a verify error
        raise WayzaVerifyError(f"could not fetch signing keys from {origin}: {e}") from e
    with _cache_lock:
        _cache[origin] = (now, doc)
    return doc


def clear_key_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _load_ed25519(x_b64url: str):
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as e:  # pragma: no cover - exercised only without cryptography
        raise WayzaVerifyError(
            "verifying Wayza signatures needs Ed25519 support: pip install 'wayza-human[verify]' "
            "(installs the 'cryptography' package)"
        ) from e
    return Ed25519PublicKey.from_public_bytes(_b64decode(x_b64url, urlsafe=True))


def _home_netloc(home: str) -> str:
    """'https://wayza.com' or 'wayza.com' -> 'wayza.com'."""
    if "://" in home:
        return urlparse(home).netloc
    return home.strip("/")


def verify(
    signed_answer: dict | str,
    *,
    home: str | None = "https://wayza.com",
    insecure: bool = False,
    key_fetcher: KeyFetcher | None = None,
) -> dict:
    """Verify a signed answer record and return it (as a dict) when it is genuine.

    Raises WayzaVerifyError otherwise.

    - `home`: the home you trust, e.g. "https://wayza.com" or "wayza.com". The record must
      be signed by that home. Pass None to accept any home whose keys verify the record
      (only do this when you check `record["home"]` yourself).
    - `insecure`: allow an http:// approval URL (local tests and dev homes on localhost).
    - `key_fetcher`: optional function origin -> wayza.json document, for tests or caching.
    """
    if isinstance(signed_answer, (bytes, bytearray)):
        signed_answer = signed_answer.decode("utf-8")
    if isinstance(signed_answer, str):
        try:
            signed_answer = json.loads(signed_answer)
        except ValueError as e:
            raise WayzaVerifyError("signed answer is not JSON") from e
    if not isinstance(signed_answer, dict):
        raise WayzaVerifyError("signed answer must be an object")
    record = signed_answer
    if record.get("v") != 1 or record.get("type") != "wayza.answer":
        raise WayzaVerifyError("not a v1 wayza.answer record")
    sig = record.get("sig")
    if not isinstance(sig, dict) or sig.get("alg") != "Ed25519" or not sig.get("kid") or not sig.get("value"):
        raise WayzaVerifyError("missing or unsupported signature")

    approval_url = record.get("approval")
    record_home = record.get("home")
    if not isinstance(approval_url, str) or not isinstance(record_home, str):
        raise WayzaVerifyError("record has no approval URL or home")
    parsed = urlparse(approval_url)
    if parsed.scheme != "https" and not (insecure and parsed.scheme == "http"):
        raise WayzaVerifyError(f"approval URL must be https: {approval_url}")
    if parsed.netloc != record_home:
        raise WayzaVerifyError("approval URL is not on the home that signed it")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    if not approval_url.startswith(origin + "/"):
        raise WayzaVerifyError("approval URL is not on the home that signed it")
    if home is not None and _home_netloc(home) != record_home:
        raise WayzaVerifyError(f"signed by {record_home!r}, expected {_home_netloc(home)!r}")

    doc = (key_fetcher or fetch_well_known)(origin)
    keys = ((doc or {}).get("home") or {}).get("keys") or []
    entry = next((k for k in keys if isinstance(k, dict) and k.get("kid") == sig["kid"]), None)
    if entry is None:
        raise WayzaVerifyError(f"unknown signing key {sig['kid']!r} for {record_home}")
    jwk = entry.get("jwk") or {}
    if entry.get("alg", "Ed25519") != "Ed25519" or jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
        raise WayzaVerifyError("signing key is not Ed25519")

    public_key = _load_ed25519(jwk["x"])
    body = {k: v for k, v in record.items() if k != "sig"}
    message = canonical(body).encode("utf-8")
    try:
        public_key.verify(_b64decode(sig["value"], urlsafe=False), message)
    except Exception as e:  # cryptography raises InvalidSignature
        raise WayzaVerifyError("signature does not verify") from e
    return record


__all__ = ["verify", "fetch_well_known", "clear_key_cache", "WayzaVerifyError", "WayzaError"]
