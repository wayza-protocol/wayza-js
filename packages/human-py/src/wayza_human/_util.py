"""Small stdlib-only helpers: canonical JSON, timeouts, request ids."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any

_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
_PART = re.compile(r"(\d+(?:\.\d+)?)\s*([smhdw])", re.I)

MAX_EXPIRY = 30 * 86400  # the server refuses expires_at more than 30 days ahead


def canonical(value: Any) -> str:
    """Canonical JSON, matching the JS reference in CONTRACT.md for these records."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def parse_timeout(timeout: Any) -> float | None:
    """Seconds from a number, or from strings like "90", "30s", "15m", "24h", "2d", "1h30m".

    None means "no timeout".
    """
    if timeout is None:
        return None
    if isinstance(timeout, bool):
        raise ValueError("timeout must be seconds or a string like '24h'")
    if isinstance(timeout, (int, float)):
        if timeout < 0:
            raise ValueError("timeout must not be negative")
        return float(timeout)
    if isinstance(timeout, timedelta):
        return timeout.total_seconds()
    if isinstance(timeout, str):
        text = timeout.strip().lower().replace(" ", "")
        if not text:
            raise ValueError("empty timeout")
        try:
            n = float(text)
        except ValueError:
            pass
        else:
            if n < 0:
                raise ValueError("timeout must not be negative")
            return n
        pos = 0
        total = 0.0
        for m in _PART.finditer(text):
            if m.start() != pos:
                break
            total += float(m.group(1)) * _UNITS[m.group(2).lower()]
            pos = m.end()
        if pos != len(text) or pos == 0:
            raise ValueError(f"cannot read timeout {timeout!r}; use seconds or e.g. '24h', '30m', '2d'")
        return total
    raise ValueError(f"cannot read timeout {timeout!r}")


def expires_at_from(seconds: float | None) -> str | None:
    """An RFC 3339 expiry `seconds` from now, capped at the server's 30 days."""
    if seconds is None:
        return None
    seconds = min(seconds, MAX_EXPIRY - 60)
    at = datetime.now(timezone.utc) + timedelta(seconds=seconds)
    return at.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def stable_request_id(fields: dict[str, Any]) -> str:
    """A stable idempotency key derived from the ask itself.

    The same ask (same title, details, recipients, choices...) hashes to the same id,
    so a retried or replayed call returns the existing approval instead of asking twice.
    Pass your own `request_id` (for example "run-77/tool-call-3") when the same question
    may legitimately be asked again later.
    """
    material = {k: v for k, v in fields.items() if v is not None}
    digest = hashlib.sha256(canonical(material).encode("utf-8")).hexdigest()
    return "wh-" + digest[:40]
