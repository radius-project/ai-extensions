---
"radius": patch
---

**Fixed:** Recover from eligible temporary workflow-read failures with bounded retries that respect GitHub's retry deadlines across polling, while retaining confirmed deployment outcomes when diagnostic evidence is unavailable. Resume artifact reads after timed cooldowns and release retired payloads during long deployments.

When a closed Canvas instance is physically stopped, Radius ends its local deployment monitoring and subsequent automatic repair handoff without cancelling the GitHub workflow. Monitoring continues during the existing deferred close for an active environment task.
