---
"radius": patch
---

**Security:** The AWS app permissions boundary now stops app IAM roles from changing account-wide security settings in any region: S3 Block Public Access for the account, EBS default encryption and its default KMS key, EC2 image and snapshot Block Public Access, CloudTrail trails, and GuardDuty detectors.

AWS environments set up by an earlier build must be deleted and created again, because setup refuses a boundary that differs from the one it writes.
