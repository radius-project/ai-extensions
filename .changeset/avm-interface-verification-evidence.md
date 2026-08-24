---
"radius": patch
---

Make the `radius-app-bicep` AVM interface-verification rule enforceable. The
skill told the author to confirm an AVM module's parameter and output names
against an existing recipe pack in `resource-types-contrib/recipepack/azure/`,
but that path does not exist — the real one is `recipe-packs/azure/`. A lookup
at the documented path returned nothing, which is indistinguishable from "no
pack uses this module", so the author fell back to the module's default-branch
README. That README documents the newest release, so a recipe pack could pin
`:0.12.0` while mapping an output that only exists from `:0.15.0` onward.

`custom-resource-types.md` §4a now cites the correct path, tells the author to
search by **module path** rather than type name (the canonical Azure pack
provisions `Radius.Data/mongoDatabases` from `avm/res/document-db/database-account`
and `Radius.Messaging/kafka` from `avm/res/event-hub/namespace`, so a type-name
grep misses the reusable evidence), and gives a version-pinned `main.bicep` URL
for when no pack uses the module. The Validation section adds a gate requiring
every `outputs` value — including nested `secrets` — and every `parameters` key
to be checked against the pinned version. Radius now rejects mappings to
undeclared module outputs at deploy time, but that check does not cover
`parameters`, so up-front verification still matters.
