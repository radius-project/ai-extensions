---
"radius": patch
---

Relay canvas deploy failures back to Copilot chat so a failed deployment is never silently confined to the canvas.

- Fix a race in the deploy outcome monitor that flipped the deploy status to "failed" before the error text was assembled. A status poll landing in that window could relay a repair handoff with an empty error and mark it delivered, permanently hiding the real failure — the "flaky error logs" symptom.
- Relay run-unconfirmed failures (dispatch rejected, no workflow run surfaced, or monitoring timed out) to chat as an informational report that asks the agent to tell the user and not automatically redeploy, since a run may still be in flight. This notice is fully isolated from the repair-and-redeploy loop, so it never turns on the panel's repairing state.
