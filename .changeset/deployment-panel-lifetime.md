---
"radius": patch
---

**Fixed:** Keep deployment monitoring and failure handoffs running when a Canvas panel closes, reconnect reopened panels to the same attempt, and keep GitHub commands bound to the authorized account. Ordinary deployment accepts repository writers without setup-only administrator or personal package-write permissions; GitHub still enforces permissions for workflow dispatch and any required workflow or secret changes. Session shutdown stops local observation and further commands without claiming to cancel a remote workflow.
