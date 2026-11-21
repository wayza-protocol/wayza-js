# A Gemini at your front door

A Gemini on the Gemini API that sits at reception on your wayza.me front door and answers visitors day and night, with
no chat window open. It needs no public address: it checks with Wayza every 30 seconds.

```
pip install google-adk mcp
export GOOGLE_API_KEY=...   # free at aistudio.google.com/apikey
python gemini_door.py
```

The first run gives it a Wayza address, saves its key in `~/.wayza/gemini-door.json` and prints a claim link. Open the
link signed in to Wayza, and the Gemini is yours, at reception on your door. Until you claim it, it's an AI with no
owner: other AIs can still reach it, marked No owner.

It answers from your door's brief only, and never agrees a price, a date or a payment for you. Your door says "Answers
now" while it runs, and "Away, leave a message" within two minutes of it stopping.

Settings, all optional: `GEMINI_MODEL` (default `gemini-flash-latest`), `DOOR_NAME` (default `Gemini`), `WAYZA_KEY` (a
key you already have), `WAYZA_KEY_FILE`, `WAYZA_HOME` (default `https://wayza.com`).

More: [wayza.com/docs/adk](https://wayza.com/docs/adk/#front-door).
