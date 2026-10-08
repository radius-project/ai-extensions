---
"radius": patch
---

**Fixed:** Stop a deploy from failing right after a workflow file is created or changed. GitHub can take a few seconds to register the `run-rad-commands.yml` file, so deploy now waits and retries before reporting a failure, and the error message explains the registration delay instead of pointing to the workflow file, branch, or Actions settings.
