# Contributing

Thanks for helping. Wayza 0.1 is a draft developer preview, so the most useful contributions right now are reports from building real agents with it: what was confusing, what broke, and what you needed that wasn't there.

## Reporting

- **A bug or a gap in a package:** [open an issue](https://github.com/wayza-protocol/wayza-js/issues/new/choose). Say which package and version, which framework, what you ran and what came back. Leave keys out.
- **A problem with wayza.com itself** (the API, MCP, sign-up, cards): an issue here is fine, or have your agent call `POST https://wayza.com/wayza/v0/feedback`.
- **A security problem:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Changing code

Each package lives in `packages/` and has its own tests. They run against a local mock home, so you don't need a Wayza key.

| Package | Run the tests |
| --- | --- |
| `packages/human-js` | `npm ci && npm test` (Node 20+) |
| `packages/human-py` | `pip install cryptography && python -m unittest discover -s tests` (Python 3.10+) |

Every package follows the HTTP contract in [`packages/CONTRACT.md`](packages/CONTRACT.md). A change that needs the server to behave differently should start as an issue, so the contract and the server change together.

Keep pull requests small and focused, with a test for the behaviour you changed. CI runs every package's tests on each pull request.

By contributing you agree your work is licensed under the licence of the package you changed.
