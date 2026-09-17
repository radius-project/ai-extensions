export interface QualifiedWorkflowAssets {
  readonly workflow: string;
  readonly executionVersion: 1;
  readonly producerRef: string;
  readonly selectedFiles: Readonly<Record<string, string>>;
  readonly reviewedFiles: Readonly<Record<string, string>>;
  readonly producerFiles: Readonly<Record<string, string>>;
  readonly reviewedProducerFiles: Readonly<Record<string, string>>;
}

export function qualifiedLifecycleWorkflowAssets(
  value: QualifiedWorkflowAssets
): boolean {
  return (
    value.executionVersion === 1 &&
    value.workflow === ".github/workflows/run-rad-commands.yml" &&
    /^[a-f0-9]{40}$/.test(value.producerRef) &&
    [
      "run-rad-commands.yml",
      "run-rad-commands-azure.yml",
      "run-rad-commands-aws.yml"
    ].every(
      (file) =>
        !!value.selectedFiles[file] &&
        value.selectedFiles[file] === value.reviewedFiles[file]
    ) &&
    ["run-rad-commands-azure.yml", "run-rad-commands-aws.yml"].every(
      (file) =>
        value.selectedFiles[file].includes(
          `actions/lifecycle-evidence@${value.producerRef}`
        ) &&
        value.selectedFiles[file].includes(
          `actions/publish-lifecycle-result@${value.producerRef}`
        ) &&
        [
          "lifecycle-evidence/action.yml",
          "lifecycle-evidence/evidence.sh",
          "run-rad-commands/action.yml",
          "restore-state/action.yml",
          "teardown/action.yml",
          "publish-lifecycle-result/action.yml",
          "deploy-progress/progress.sh"
        ].every(
          (file) =>
            !!value.producerFiles[file] &&
            value.producerFiles[file] === value.reviewedProducerFiles[file]
        )
    )
  );
}
