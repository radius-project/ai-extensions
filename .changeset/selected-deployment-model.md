---
"radius": patch
---

**Fixed:** Deploy the selected application model consistently, including its parameters and workflow artifacts, instead of substituting a default model. Missing or unsupported paths now stop before dispatch; select root `app.bicep` explicitly rather than relying on fallback from `.radius/app.bicep`.
