---
"radius": patch
---

Fix generated custom resource types rejecting `codeReference`. The `radius-app-bicep` skill told the agent to author `codeReference` on every non-application resource, but a generated `Radius.Resources/*` type compiles to a closed object built from `custom-types.yaml`, so any model using a custom type failed with `BCP037: The property "codeReference" is not allowed`. The custom-type schema template now always declares an optional `codeReference` string (an explicit property rather than `additionalProperties: true`, so closed-schema validation is kept), the publish step states that `custom-types.tgz` must be republished after any manifest edit, and the skill wording no longer claims `codeReference` is inherited by every type — built-in types get it from Radius's base resource schema, custom types must declare it.
