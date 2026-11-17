---
"radius": patch
---

**Security:** App IAM roles in an AWS environment can no longer weaken account-wide security settings in any region. They can't turn off or relax the account's S3 Block Public Access, EBS default encryption, or EC2 image or snapshot Block Public Access, change or reset the default EBS KMS key, stop, delete, or update CloudTrail trails or change their event selectors, delete or update GuardDuty detectors, or create or update GuardDuty filters or trusted IP lists.
