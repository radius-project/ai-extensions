export const ROLLBACK_COMPLETE_REASON = "rollback-complete";
export const CLEANUP_COMPLETE_REASON = "cleanup-complete";
export const SETUP_EXITED_REASON = "setup-exited";

export const SETUP_DELETED_REASONS = [
  ROLLBACK_COMPLETE_REASON,
  CLEANUP_COMPLETE_REASON
] as const;

export function isSetupDeletedReason(reason: string): boolean {
  return SETUP_DELETED_REASONS.some((candidate) => candidate === reason);
}
