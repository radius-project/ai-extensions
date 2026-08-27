---
"radius": patch
---

Stop application modeling from wiring a backing service whose credential the application cannot read. A resource type exposes its credential in one shape — an aggregate connection URL, or discrete host/port/password values — and a client accepts only the shape it parses. Modeling now checks the two against each other before committing to a type, and reports a mismatch instead of emitting a definition that deploys and never authenticates.

The gap that motivated this was a cache type whose only credential is a `rediss://` URL, wired to a .NET client that reads `host:port,password=…` from a single variable in an image with no shell to rewrite it. Nothing in the model could carry the access key alone, and `host` and `port` on their own looked fine — they are enough against an unauthenticated in-cluster recipe, and silently drop authentication against the managed, keyed service the same type is meant to cover.

So whether a credential exists is now settled by the exact Recipe rather than by the type's metadata, since a Recipe can map the same key to an unauthenticated value; address outputs stand alone only where that Recipe provably issues none, and the reply then names it. An aggregate credential is never split in Bicep or in an authored secret, no undeclared property is invented to stand in for a key, and a runtime split counts only where the application parses the value itself or the image demonstrably carries the shell or parser to do it. When nothing fits, the run reports the type, the Recipe, the keys it exposes, the source line that needs a different shape, and what would unblock it — and publishes nothing.
