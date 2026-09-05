---
"radius": patch
---

Harden Radius Canvas application graphs against accidental secret disclosure. Canvas-generated graph artifacts and modeled or deployed graph state now retain only required resource, relationship, and provider-output metadata; non-null graph-visible `Radius.Security/secrets` data is rejected before the graph is saved or rendered.
