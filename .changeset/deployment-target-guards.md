---
"radius": patch
---

**Fixed:** Prevent overlapping local deploy, delete and abandon operations for the same repository and environment across tools and panels. Refuse deployment when its default branch cannot be resolved instead of silently choosing `main`.
