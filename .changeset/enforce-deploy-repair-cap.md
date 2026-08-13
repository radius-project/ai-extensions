---
"radius": patch
---

Enforce the automatic deploy-repair attempt cap in the canvas instead of only stating it in the handoff prompt. The canvas now counts the redeploys an agent makes inside a repair loop, refuses a redeploy once the cap is reached (before any workflow run is dispatched), and reports "automatic repair attempt N of M" on every `radius_deploy` call so the agent can wind down gracefully rather than being cut off. The count resets whenever a deploy opens a new attempt.
