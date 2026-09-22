---
"radius": patch
---

Advance the pinned Radius contrib catalog to `9cdf55cd`, moving the default resource-type manifests and both recipe packs to the `recipe-pack/azure/v0.3.0` and `recipe-pack/kubernetes/v0.2.0` releases. Those packs define only `Radius.Core/recipePacks`, so generated deploy workflows now create the environment separately and attach the pack explicitly.
