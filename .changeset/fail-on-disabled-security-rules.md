---
"radius": patch
---

**Security:** Application model validation now fails when a Bicep credential-safety rule has been turned off instead of passing silently. A rule set to `off` or `info` in `bicepconfig.json`, a disabled Bicep linter, or a `#disable-next-line` or `#disable-diagnostics` directive naming one of these rules previously let a model with a hardcoded credential in a sensitive property validate cleanly. Validation now names the setting and the rule so it can be removed and the underlying problem fixed. This covers `use-secure-value-for-secure-inputs`, `secure-parameter-default`, `secure-secrets-in-params`, `outputs-should-not-contain-secrets`, and `secure-params-in-nested-deploy`. Settings for other rules in `bicepconfig.json` are still preserved.
