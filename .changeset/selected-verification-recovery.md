---
"radius": patch
---

Pin credential-verification retry, workflow discovery, and monitoring to the GitHub account selected for the environment operation. Verification now records exact run identity before dispatch, retries selected-account acquisition within a durable deadline, gives workflow monitoring its own bounded window, and reports authorization, rate-limit, baseline, persistence, and restart failures with actionable guidance without falling back to the ambient GitHub CLI account.
