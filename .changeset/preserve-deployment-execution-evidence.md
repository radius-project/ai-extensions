---
"radius": patch
---

**Fixed:** Preserve confirmed deployment outcomes when artifact reads fail, ignore superseded deployment attempts, redact deployment diagnostics, and prevent automatic retries or immediate repeat deletion after an uncertain application-delete dispatch. Report malformed GitHub artifact listings as failures instead of treating them as proof that no deployment exists.
