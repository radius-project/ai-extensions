---
"radius": patch
---

**Fixed:** Deploy the selected application model consistently, including its parameters and workflow artifacts, instead of substituting a default model. Canvas resolves `.radius/app.bicep` or root `app.bicep` for the selected repository and branch. Explicit tool paths remain strict; missing paths and filenames reserved for generated setup stop before dispatch.
