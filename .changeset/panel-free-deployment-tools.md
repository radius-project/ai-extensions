---
"radius": minor
---

**Added:** Deploy and monitor applications without opening Canvas. Each deployment returns an observation-only handle; repair handoffs retain a separate attempt ID. Omitting the start attempt ID or passing an empty string starts a fresh attempt, not a repair. Attempts are not restored after an extension restart.
