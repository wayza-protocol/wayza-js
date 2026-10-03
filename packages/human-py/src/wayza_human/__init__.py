"""wayza_human: send an agent's pause-for-approval to a real person through Wayza,
and resume on their signed answer.

Core is stdlib-only. Signature verification needs `pip install 'wayza-human[verify]'`.
Framework adapters live in submodules: wayza_human.langgraph, .crewai, .adk, .openai_agents.
"""

from ._answer import check_answer, request_fingerprint
from ._client import DEFAULT_HOME, AsyncWayza, Result, Wayza, __version__, parse_callback
from ._errors import WayzaError, WayzaTimeout, WayzaVerifyError
from ._util import canonical, parse_timeout, stable_request_id
from ._verify import clear_key_cache, verify

__all__ = [
    "Wayza",
    "AsyncWayza",
    "Result",
    "verify",
    "parse_callback",
    "request_fingerprint",
    "check_answer",
    "WayzaError",
    "WayzaTimeout",
    "WayzaVerifyError",
    "canonical",
    "parse_timeout",
    "stable_request_id",
    "clear_key_cache",
    "DEFAULT_HOME",
    "__version__",
]
