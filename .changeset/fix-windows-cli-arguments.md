---
"radius": patch
---

Preserve command arguments when Radius invokes Azure, AWS, or Kubernetes CLI batch launchers on Windows. Parenthesized Microsoft Graph URLs and JSON bodies now remain separate arguments during Azure environment setup, while ordinary `az` commands and absolute CLI paths containing spaces continue to work.
