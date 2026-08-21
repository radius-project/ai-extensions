---
"radius": patch
---

Remove verified dead code from the `core` package and shrink its public export surface to the names adapters actually import. The unused `ComputePlatform.generateOidc`, `environmentSecrets`, `recipePlatform`, and `supports` members are gone (the canvas performs OIDC through `buildOidcSubject`/`buildFederatedCredentialName`, which are unchanged), as are the aspirational `Shell`, `StateStore`, `Clock`, `Logger`, and `Ports` port interfaces. No adapter-visible behavior changes.
