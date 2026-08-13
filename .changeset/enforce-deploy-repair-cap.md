---
"radius": patch
---

Enforce the automatic deploy-repair attempt cap in the canvas instead of only stating it in the handoff prompt. The canvas now counts the redeploys an agent makes inside a repair loop, refuses a redeploy once the cap is reached (before any workflow run is dispatched), and reports "automatic repair attempt N of M" on every `radius_deploy` call so the agent can wind down gracefully rather than being cut off. An attempt-bound redeploy is also now accepted only while that attempt is in a failed state, so a duplicate call cannot start a second workflow run over a deploy that is still going, and reuse after a successful repair opens a new deploy instead of spending budget on a loop that already finished.
