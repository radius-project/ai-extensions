# @radius-project/core

## 0.2.0

### Minor Changes

- [#1110](https://github.com/radius-project/ai-extensions/pull/1110) [@nicolejms](https://github.com/nicolejms) - **Added:** Make the browser-safe graph contracts and React graph renderer available as public npm packages, with compiled JavaScript, TypeScript declarations, and graph stylesheets.

### Patch Changes

- [#1176](https://github.com/radius-project/ai-extensions/pull/1176) [@AzureMike](https://github.com/AzureMike) - **Fixed:** Include the required minimum when the AWS CLI version is unreadable. Classify credential failures consistently, redact AWS credential fields, and offer installation help without replacing configured credential providers.

  Keep credential-helper command failures separate from a missing AWS CLI, and recognize expired SSO refresh tokens as requiring sign-in.

- [#1177](https://github.com/radius-project/ai-extensions/pull/1177) [@AzureMike](https://github.com/AzureMike) - **Fixed:** Hash repository and environment identities into AWS inline policy names and persist the exact name for cleanup. Restrict service-linked-role creation to supported recipe services, omit service-linked-role deletion, and exclude EKS access administration from regional grants. Compact policies support about 17 environments per role without other inline grants; `account:GetPrimaryEmail` is no longer included.
