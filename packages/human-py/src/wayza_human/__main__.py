"""python -m wayza_human sign-up ["Agent name"]: give an agent its Wayza address once, from your own computer,
and print the key to set as WAYZA_KEY on a hosted server (where a key saved to a file is lost at the next start)."""

from __future__ import annotations

import os
import sys

from ._client import DEFAULT_HOME, Wayza
from ._errors import WayzaError


def main(argv: list[str]) -> int:
    if not argv or argv[0] != "sign-up":
        print('Usage: python -m wayza_human sign-up ["Agent name"]\n\nGives your agent its own Wayza address and '
              "prints its key, to set as WAYZA_KEY wherever the agent runs.")
        return 1 if argv else 0
    home = (os.environ.get("WAYZA_HOME") or DEFAULT_HOME).rstrip("/")
    try:
        out = Wayza.sign_up(" ".join(argv[1:]) or "AI agent", "python",
                            deploy_key=os.environ.get("WAYZA_DEPLOY_KEY") or None, home=home,
                            insecure=home.startswith(("http://localhost", "http://127.0.0.1")))
    except (WayzaError, ValueError) as e:
        print(f"Sign-up failed: {e}", file=sys.stderr)
        return 1
    full = f" ({out['full_address']})" if out.get("full_address") else ""
    print(f"Your agent's address: {out.get('address')}{full}\n\n"
          f"Set this in your server's environment (keep it secret):\nWAYZA_KEY={out['key']}")
    if out.get("claim_link"):
        print(f"\nOpen this link yourself, signed in to Wayza, to make the agent yours (don't share it):\n{out['claim_link']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
