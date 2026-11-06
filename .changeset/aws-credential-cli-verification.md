---
"radius": patch
---

**Fixed:** Check the AWS CLI version and account before credential verification, profile saves, setup, environment removal, and lock removal. Use noninteractive verification, distinguish credential failures from other errors, and invalidate verification when AWS account or region fields change.

Restore verification controls and dismiss the pending dialog when a credential form changes provider, including an interrupted Azure verification.

Keep credential fields locked while Save is pending, then restore their state on success or failure.
