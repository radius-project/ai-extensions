---
"@radius-project/adapter-canvas": patch
---

Derive the pull-request guidance shown during environment creation from the
verification decision instead of predicting it. When Radius lacked push access
and committed the setup workflows to a branch, the progress log told the
customer that credential verification and deploys would run once the pull
request landed on the default branch. That sentence was written at
pull-request time, before `planCredentialVerification` and the cloud-credential
check had decided anything, so a repository that already carried the verify
workflow on its default branch was told verification was waiting for a merge in
the same run that dispatched it against the setup branch. The guidance is now
emitted once, after that decision is known, and both its wording and its step
marker follow it: a run that dispatches from the setup branch finishes with
`actionRequired` false, so it records an observation that setup is not blocked
on the merge, while a run that genuinely waits still prompts for it.
