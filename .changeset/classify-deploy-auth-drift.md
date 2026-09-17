---
"radius": patch
---

Detect cloud credential drift on a redeploy (exception 5.2). When a deploy run fails at its cloud login/credentials step before `rad deploy` touches any resource — meaning an environment that verified earlier no longer authenticates because its trust or permissions changed — the deploy panel now explains that the credentials drifted and offers a Re-verify credentials action that opens the Environments list, instead of showing a raw workflow error. The failure is also stamped with a dedicated kind so the automatic repair loop leaves it for the user to re-verify rather than redeploying an unchanged, still-failing configuration.
