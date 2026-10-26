---
"radius": patch
---

**Fixed:** Keep environment setup running when its panel closes, reuse the same operation when it reopens, and stop local verification and further setup work safely when the session shuts down without claiming to cancel remote work.

Session shutdown also stops cleanup between deletions and configuration between individual variable writes. Writes already in flight retain their account until their acknowledged results are recorded; interrupted cleanup and verification discovery remain resumable instead of reporting completion.

Verification dispatch and automatic run discovery stop further reads and monitoring after shutdown, without turning a late response into a setup failure. Sent requests retain their actual outcome; uncertain dispatches require inspection before another run can be sent, including after restart. Storage failures remain explicit.
