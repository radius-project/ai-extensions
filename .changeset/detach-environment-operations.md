---
"@radius-project/adapter-canvas": patch
---

Move environment creation to a server-owned operation that returns `202 Accepted`, continues after the initiating Canvas request ends, pauses in an explicit `input_required` state, and resumes the same persisted operation from structured user input.
