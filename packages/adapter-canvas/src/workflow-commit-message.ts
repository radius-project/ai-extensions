const SKIP_CI_DIRECTIVE = "[skip ci]";

export function workflowCommitMessage(
  message: string,
  suppressCi: boolean
): string {
  return suppressCi ? `${message} ${SKIP_CI_DIRECTIVE}` : message;
}
