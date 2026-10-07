# Phone approvals for Claude Code and Codex

When your coding agent stops to ask permission ("Run `npm test`?", "Edit server.js?"), the question comes to your phone.
Tap **Approve** or **Decline** and the agent carries on. If you don't answer within about nine minutes, nothing
happens: the normal prompt waits on your computer, as it always did. It never allows anything by itself.

It works through [Wayza](https://wayza.com): the hook gets its own Wayza address, you confirm it's yours, and from then
on it asks you, and only you, for a yes.

## Set up (once per computer)

You need Node 18 or later.

1. Install the hook (below, for Claude Code or Codex).
2. Run `node <path>/bin/wayza-approve.mjs setup --name "Claude Code"`. It prints a link: open it on your phone and sign in
   to Wayza, or make a free account. That makes the hook's address yours.
3. It sends you a first ask straight away. Tap **Approve**.
4. On your phone, open **wayza.com/account/notify** and turn on notifications. On an iPhone, add Wayza to your home
   screen first (the page shows how).

### Claude Code

```
/plugin marketplace add wayza-protocol/wayza-js
/plugin install phone-approvals@wayza
```

Then run setup with the path Claude Code installed it to, or copy `bin/wayza-approve.mjs` anywhere and run it from there.

### Codex

Copy `bin/wayza-approve.mjs` to `~/.wayza/wayza-approve.mjs`, then add the entry in `codex-hooks.json` to
`~/.codex/hooks.json`. Run setup the same way.

## What is sent

The tool, the project folder's name, and the command or file, so you can judge what you're allowing. Anything that
looks like a key, token or password is replaced with `[hidden]` on your computer before it is sent. Asks are stored
on Wayza as plain text, like any other ask (encrypted in transit, not end to end), and your answer comes back with a
record signed by Wayza.

## Commands

| Command | What it does |
| --- | --- |
| `wayza-approve setup [--name "Claude Code"]` | Get an address and connect it to you |
| `wayza-approve status` | Who it asks |
| `wayza-approve forget` | Remove the key from this computer |
| `wayza-approve hook` | The hook itself (Claude Code and Codex run this) |

Settings live in `~/.wayza/phone-approvals.json`, readable only by you. `WAYZA_APPROVALS_WAIT` sets how many seconds
to wait for your answer (default 540; keep it under the hook's 600-second timeout).

An AI asking only its own person can ask up to 300 times a day; Wayza sends at most 20 notifications in 10 minutes.
Asks beyond that still wait on your account page.
