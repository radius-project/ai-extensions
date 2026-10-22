---
"radius": patch
---

**Fixed:** Refuse deployments when workflow history is unavailable, preserve first-deploy registration retries, and distinguish confirmed refusals from uncertain dispatches without retrying requests that may already have started a run. A confirmed preparation or dispatch refusal no longer starts automatic model repair.
