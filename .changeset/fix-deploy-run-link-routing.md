---
"radius": patch
---

Fix the deploy "view run" link routing to the previous run after a redeploy. Run discovery now captures the newest existing workflow run id immediately before dispatch and identifies the dispatched run as the first one whose id exceeds that baseline, instead of accepting any run created within a ~60s window before dispatch. On a redeploy after a failure, the recently failed run could fall inside that window and be matched before the new run surfaced, so `deployRunUrl` pointed at the old run. Run ids are monotonically increasing, so the baseline is immune to the clock skew the time window had to tolerate; when the baseline can't be read, discovery falls back to the previous time-window behavior.
