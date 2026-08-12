---
"radius": patch
---

Keep a repair-loop redeploy on the attempt id it was given. `radius_deploy` and `radius_deploy_status` are documented as a pair the agent drives with one `attemptId`, but `/api/deploy` minted a fresh id on every call, so the redeploy retired the very id the agent was told to keep passing and the next status poll answered "no longer active" for a deploy that was running fine. `/api/deploy` now reuses an `attemptId` supplied in the request body, and only when it matches the attempt that is current, so a stale or invented id still cannot resurrect a finished attempt. Because a pinned redeploy no longer changes the id, deploy runs are counted by a separate `deployGeneration` and the repair handoff's staleness guard checks both: the attempt id still names the logical repair loop, while the generation identifies the physical run whose async callbacks must not speak for a later one.
