---
"radius": patch
---

**Fixed:** Preserve confirmed deployment outcomes when diagnostic logs or graph artifacts cannot be read, keep attributable deployment errors ahead of teardown errors, and avoid treating an unconfirmed workflow outcome as a confirmed failure.

Stop waiting when GitHub reports a completed workflow with an unsupported outcome. Report that the outcome could not be confirmed without suggesting the workflow is still running or starting automatic repair; missing outcomes retain their recovery window.
