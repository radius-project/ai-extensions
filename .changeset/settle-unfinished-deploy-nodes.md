---
"radius": patch
---

Explain why a resource went red when the deploy run — not the resource — decided the outcome (exception 5.1). A cancelled run now marks its unfinished resources "Deployment cancelled" and a timed-out run marks them "Deployment timed out", while an ordinary failure carries the exact Radius error extracted from the run log, falling back to "Deployment failed" when no detail is available. A resource the deploy already reported as failed keeps its own, more specific message, and a resource reported failed without any message finally gets one. When canvas monitoring gives up watching a run, it now settles the graph on the way out instead of leaving resources stuck pending or in progress, so the deployment no longer looks perpetually in flight; the run is still marked unconfirmed so an automatic repair redeploy stays refused. A run that ultimately succeeded also clears any stale failure message its resources picked up along the way.
