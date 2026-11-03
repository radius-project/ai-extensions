---
"@radius-project/core": minor
"@radius-project/graph-react": minor
---

Add explicit legacy public compatibility contracts without changing strict live graph validation or native graph direction semantics. Core provides a canonical resource-ID projection and a single legacy gateway/route direction adapter. Graph React provides a context-free AppGraph and an isolated optional Flow 11 ResourceNode entry, both backed by the shared card and layout. Rendered cards expose semantic DOM attributes for real-browser observation. Invalid self/dangling edges, mutation, duplicate presentation edges, and blank empty graphs are corrected rather than preserved.

Preserve optional application/environment predicate arguments and provider-discovery resource-type names and descriptions.
