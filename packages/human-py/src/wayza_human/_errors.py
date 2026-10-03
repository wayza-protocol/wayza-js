from __future__ import annotations


class WayzaError(Exception):
    """A Wayza API error. `status` is the HTTP status (0 for network errors)."""

    def __init__(self, message: str, status: int = 0, body: object = None):
        super().__init__(message)
        self.status = status
        self.body = body


class WayzaVerifyError(WayzaError):
    """A signed answer did not verify. Treat the data as untrusted."""


class WayzaTimeout(WayzaError):
    """Nobody answered within the timeout. `approval_id` is the ask that is still waiting."""

    def __init__(self, message: str, approval_id: object = None):
        super().__init__(message)
        self.approval_id = approval_id
