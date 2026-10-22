export function needsWorkflowScope(stderr?: string): boolean {
  const text = stderr || "";
  return (
    /workflow.{0,20}scope/i.test(text) ||
    /without .?workflow.? scope/i.test(text) ||
    /workflows.? permission/i.test(text)
  );
}
