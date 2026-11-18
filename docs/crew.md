# Crew and delegated work

Milo can delegate a self-contained assignment to a named bot. The bot uses its own
context and the parent's tools, folder, permissions and stop signal; only its report
returns to the parent. Crew keeps the bot's name, assignments, models and reports in
`~/.milo/crew.json`. Milo can reuse a bot by id and give it the reports from its earlier
assignments. A bot may use a model on another configured provider; it does not change the
parent Session's model. A bot cannot delegate again.

The **Crew** page on the web and iPhone shows bots and their assignments. Each bot wears
a deterministic Dot-style avatar (shape, eyes, accessory and colour palette) that can be
shuffled or customized on its page. `/crew` lists bots on the terminal and chat gateways;
`/crew <id>` opens a bot's history, `/crew rename <id> <name>` renames a bot, `/crew avatar
<id> [shuffle | shape=<shape> eyes=<eyes> accessory=<accessory> palette=<palette>]` updates
its avatar, `/crew stop <id>` requests a stop, and `/crew guide <id> <text>` queues
guidance for its next step.
The history marks guidance as applied, queued, or not applied when a bot finishes before
it can read it. Stopping one bot does not stop its parent Session. Renaming a bot changes
its name for every surface and future assignment.

Delegated work is a persistent objective. A one-time objective runs once; a scheduled one
runs immediately and again at its configured interval or local time. Ask Milo in a Session
to create one, or ask it to list, change, pause, resume or cancel work. The **Crew** page
and `/delegated` expose the same work and history. A run opens a Session of its own and
can assemble Crew bots. Each new run receives earlier reports, so it can continue the
objective rather than treating the previous check as forgotten.

Only `milo serve` executes delegated work, and it must remain running. Missed scheduled
times are skipped on restart; they are not replayed. A run interrupted by a dead process
is marked interrupted: one-time work can be resumed manually, and scheduled work waits
for its next time. Two daemon processes cannot claim the same execution. Pausing a running
work item takes effect after its current run; cancelling requests that the run stop.

The work carries only the tools approved when it is created. An unattended run refuses
an ungranted side effect even when the install is in unrestricted mode; explicit denials
still apply. Mail sending always needs an individual approval showing the recipient,
subject and body, so it cannot be granted to unattended work. Changing an objective or
resuming work through the agent asks before rearming it. Results go to the chosen chat,
or remain in the work history when the destination is `none`; a delivery failure is kept
on the run. The Session folder is inherited at creation and used for each execution.
