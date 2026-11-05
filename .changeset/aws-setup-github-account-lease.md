---
"radius": patch
---

**Fixed:** While AWS setup waits for another run to release the deploy identity lock, the original GitHub CLI account stays active. GitHub readiness checks and verification workflow inspection and cancellation can switch accounts during the wait instead of failing because the account is in use. Before it configures the GitHub environment, AWS setup waits for any other GitHub CLI account work to finish and selects its account again.
