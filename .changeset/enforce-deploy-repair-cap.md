---
"radius": patch
---

Enforce the automatic deploy-repair attempt cap in the canvas instead of only stating it in the handoff prompt. The canvas now counts the redeploys an agent makes inside a repair loop, refuses a redeploy once the cap is reached (before any workflow run is dispatched), and reports "automatic repair attempt N of M" on every `radius_deploy` call so the agent can wind down gracefully rather than being cut off. An attempt-bound redeploy is also now accepted only against a deploy that is confirmed failed: one that is still running, one that already succeeded, or one whose monitoring timed out or died while the workflow may still be live is refused with a pointer to what to do instead, so a repair can never race a second workflow run against the same target.
