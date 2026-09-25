---
"radius": patch
---

**Security:** Pass Azure environment variables into the generated workflows' shell steps through the environment instead of substituting them into the script, so a value containing shell syntax is treated as data rather than as commands. No reconfiguration is needed; the same variables are read and resolve to the same values.
