---
"radius": minor
---

Let users create an environment even when credential verification fails for a reason they can accept (exceptions 4.4 permissions and 4.5 cluster/cloud unreachable). The failed-verification panel now offers a **Create Environment anyway** action that records a durable `RADIUS_VERIFICATION_BYPASSED` marker on the GitHub Environment. The Environments list then reports the environment as `bypassed` — a distinct, deployable status labelled `(verification bypassed)` rather than masquerading as verified — so deploys are unblocked without discarding the real verification result. Bypass is offered only for recoverable failures (never for OIDC-trust or unknown errors), and a later genuine verification success supersedes the marker.
