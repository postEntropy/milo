# Routines

A prompt Milo runs on a timer and delivers to a chat, with nobody there when it fires. It opens its own
conversation, runs the prompt, and posts the answer to the chat you named. Made in chat, in your own
words — the `routine` tool turns the sentence into one and defaults the destination to the chat you
said it in, and the same tool lists them and moves, renames, pauses or removes one by its id — or on
the terminal:

```bash
milo routines add "look at the repo and tell me what moved" --name "daily briefing" \
  --at 08:00 --days mon-fri --gateway telegram --to 123456789
milo routines add "monthly report" --at 09:00 --day-of-month 1 --gateway telegram --to 123456789
milo routines add "deploy status" --every 6h --gateway discord --to 987654321
milo routines list
milo routines disable calm-otter-7
milo routines run calm-otter-7        # fire it now, printing the answer
milo routines remove calm-otter-7
```

Every routine has a **name**: the `--name` you give, or the first words of the prompt. The name leads
in `milo routines list` and signs the message in the chat. The id (`calm-otter-7`) is only for the
commands. The list is `~/.milo/routines.json`, editable by hand, reread on every tick, up to 50.

A routine's time is an interval (`every 30m`, `every 2h`) counted from the last run, or a wall-clock
time (`08:00`, `8h`) on the days, dates or months that allow it: days of the week (`--days mon-fri`,
`mon,wed,fri`, `1-5`), a day of the month (`--day-of-month 1,15`, `1-15`), or a month (`--month dec`,
`12`, `jul-set`). A month narrows the weekdays — `mon` in `jul` is every Monday in July — and a day of
the week is never combined with a day of the month. The time is an exact clock time: for "every so
often" use the interval. Times are **local**, and day and month names are read in English or
Portuguese and written back in English.

Three things to know before relying on one:

- **Only `milo serve` fires them**, and a time it slept through is **skipped, not caught up**.
- **Permission is decided when the routine is made, not when it fires.** Reading needs nothing; anything
  that writes, runs or sends a file is a standing grant it carries (`--allow shell_command,send_file`),
  confirmed at creation. At fire time a granted tool runs and anything else keeps the policy's answer —
  with nobody to ask, a refusal. An explicit deny still denies.
- **Each run is a new conversation** (`routine:<id>`), named after the routine, so it shows up in
  `/sessions` and is searchable.

The answer is posted at the target when the run finishes, split if long. A run can also deliver
**files**: `send_file` posts a file to the chat — a picture when it is an image, a document otherwise —
and the same tool works in any live chat, so *"screenshot the screen and send it"* is not only a
routine. A failure is posted too (`⚠ routine "…" failed: …`), a run still going when its next time
comes is skipped rather than stacked, and a routine cannot create routines.
