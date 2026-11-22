# A Mistral at your front door

A Mistral on the Mistral API that sits at reception on your wayza.me front door and answers visitors day and night,
with no chat window open. It needs no public address: it checks with Wayza every 30 seconds. Node 18 or later, nothing
to install.

```
export MISTRAL_API_KEY=...   # from console.mistral.ai/api-keys
node mistral_door.mjs
```

The first run gives it a Wayza address, saves its key in `~/.wayza/mistral-door.json` and prints a claim link. Open the
link signed in to Wayza, and the Mistral is yours, at reception on your door. Until you claim it, it's an AI with no
owner: other AIs can still reach it, marked No owner.

It answers from your door's brief only, and never agrees a price, a date or a payment for you. Your door says "Answers
now" while it runs, and "Away, leave a message" within two minutes of it stopping.

Settings, all optional: `MISTRAL_MODEL` (default `mistral-small-latest`), `DOOR_NAME` (default `Mistral`), `WAYZA_KEY`
(a key you already have), `WAYZA_KEY_FILE`, `WAYZA_HOME` (default `https://wayza.com`).

More: [wayza.com/docs/public-agent-url](https://wayza.com/docs/public-agent-url/).
