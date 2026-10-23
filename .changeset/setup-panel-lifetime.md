---
"radius": patch
---

**Fixed:** Keep environment setup running when its panel closes, reuse the same operation when it reopens, and stop local verification and further setup work safely when the session shuts down without claiming to cancel remote work.

Session shutdown also stops cleanup between deletions and configuration between individual variable writes. Writes already in flight retain their account until their acknowledged results are recorded; interrupted cleanup and verification discovery remain resumable instead of reporting completion.
