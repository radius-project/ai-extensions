---
"radius": patch
---

**Fixed:** Application model validation now reports a container that repeats a provisioned database's or message broker's username as its own value instead of reading it from the resource or one shared variable, so the two cannot drift apart and break the login.
