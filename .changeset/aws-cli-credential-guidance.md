---
"@radius-project/core": patch
---

**Fixed:** Include the required minimum when the AWS CLI version is unreadable. Classify credential failures consistently, redact AWS credential fields, and offer installation help without replacing configured credential providers.

Keep credential-helper command failures separate from a missing AWS CLI, and recognize expired SSO refresh tokens as requiring sign-in.
