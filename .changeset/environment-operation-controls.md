---
"@radius-project/adapter-canvas": patch
---

Add durable stop, resume, and retry controls to environment setup. **Stop setup** is recorded before Radius answers, so it survives a Canvas reload: Radius finishes the Azure or GitHub step already running, records what changed, and stops before the next one, or cancels immediately while it is waiting for your answer. A closed setup now offers **Retry verification** after you merge the setup pull request or Azure role assignments propagate, **Retry setup** to continue from the first unfinished step using the resources Radius already recorded, and **Retry cleanup** for resources it proved it created and could not remove. Every partial result names what was created, retained, reused, cleaned, and what still needs you. An abandoned setup is closed with a real outcome instead of leaving the repository blocked until a stale-record timer expires, and deploying your application stays a separate action you start yourself.
