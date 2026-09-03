---
"radius": patch
---

**Fixed:** Application modeling no longer binds a Redis Recipe URI directly to a StackExchange.Redis configuration setting, preventing generated deployments from failing when the client parses `REDIS_ADDR`.
