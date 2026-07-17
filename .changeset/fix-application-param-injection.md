---
"@radius-project/canvas": patch
---

Stop auto-generating and passing the `application` deploy parameter. `rad deploy`
injects both `environment` and `application` from the workspace/environment
context, so the canvas adapter now treats `application` as CLI-managed (alongside
`environment` and `image`). Previously it auto-generated a random value and
inlined `--parameters application=<random>` into the deploy command, which
corrupted the application name and caused `rad deploy` to fail with
`The following parameters were supplied, but do not correspond to any parameters
defined in the template: 'application'`.
