---
"radius": patch
---

**Fixed:** Application modeling now traces native environment and configuration values to their consuming parser, matches the exact required format, and safely composes incompatible Recipe outputs or stops before publishing a broken model. The model checker also rejects direct Recipe aggregate-secret bindings that contradict an address-shaped native setting.
