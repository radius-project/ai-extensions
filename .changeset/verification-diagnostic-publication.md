---
"radius": patch
---

**Fixed:** Redact credentials and limit diagnostic text in credential-verification progress and failures. Keep a confirmed workflow failure visible with an explicit warning when its log cannot be read, instead of replacing the known outcome with an unknown status.

Include that warning in both the response and saved failure evidence when GitHub returns no logs, as well as when the log request throws an error.
