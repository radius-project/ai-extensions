---
"radius": minor
---

**Added:** Request explicit, source-approved repair and cancellation for known lifecycle operations. Linked repairs share a five-cycle ceiling, preserve the original failure, and never authorize publication or redeployment. Cancellation requests retain independent workflow, state-save, and cleanup evidence; reading status or closing a panel starts no repair and cancels no remote work.

Canonical repair requires trusted host approval and authenticated agent outcomes, which the current native SDK does not provide. Existing legacy controls remain available without serving as a fallback for accepted canonical work.
