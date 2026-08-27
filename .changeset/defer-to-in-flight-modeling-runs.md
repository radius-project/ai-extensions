---
"radius": patch
---

Stop asking the agent to generate an application model it is already generating. The graph routes ask for authoring by sending a message on the user's turn, which is the only channel that can drive agent work — so a request raised while the agent is mid-turn is queued and delivered once that turn ends. When the turn being interrupted was the modeling run itself, the queued message arrived after the work had already started and asked for it again, which is what surfaced as a stray "1 queued message" on canvas load.

The render that finds no model happens before any modeling run is observable, so a single check at that instant cannot see one coming. The handoff now watches for a run to claim the work before it speaks, and stays quiet if one does.

- Two signals mark a run as in flight: `radius_generate_app` handing the authoring skill over, which is the earliest observable moment, and the `.radius/.staging-<runId>/` directory the promotion script creates, which is definitive at both ends. The tool announcement expires on its own and bridges the gap until the staging directory exists.
- A run that starts and finishes inside the wait is also covered: model statuses are re-resolved before the message is sent, and the handoff is abandoned if a branch is no longer missing a model.
- Deferring does not consume the deduplication key, so if the run it deferred to never produces a model, a later render asks again.
- An unreadable workspace is treated as "no run in flight" rather than as a reason to stay silent, so a broken probe cannot suppress the question.
- The message itself now asks the agent to re-check before acting, rather than asserting the model is missing, so a request that was queued behind other work no longer states something that stopped being true while it waited.
