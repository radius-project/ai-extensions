---
"@radius-project/adapter-canvas": patch
---

Allow the Canvas credential cache path to be selected explicitly so deterministic test and host environments can isolate persisted state before the adapter is imported. The Chromium harness now loads a sentinel cache from an isolated suite path, replaces the complete in-memory credential object before each journey, proves that no persisted field reaches browser state, requests, CLI logs or artifacts, and restores process state afterward. Harness cleanup now retries transient workspace locks but fails on permanent deletion errors, force-closes and deregisters a server after the graceful shutdown deadline, and unwinds partially constructed fixtures without hiding cleanup failures.
