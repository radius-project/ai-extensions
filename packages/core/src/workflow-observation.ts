export interface WorkflowStep {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

export interface WorkflowJob {
  steps?: WorkflowStep[];
}

export interface WorkflowRunDetail {
  status?: string;
  conclusion?: string | null;
  jobs: WorkflowJob[];
  steps: WorkflowStep[];
}

export interface WorkflowRunRead {
  data: Record<string, unknown>;
  includeJobs: boolean;
}

export interface WorkflowTarget {
  repo: string;
  runId: number | string;
}

export interface WorkflowObservationReads {
  readRun(
    repo: string,
    runId: number | string
  ): Promise<WorkflowRunRead | null>;
}

export async function observeWorkflowRun(
  target: WorkflowTarget,
  reads: WorkflowObservationReads
): Promise<WorkflowRunDetail | null> {
  const read = await reads.readRun(target.repo, target.runId);
  if (!read) return null;
  const { data, includeJobs } = read;
  const jobs: WorkflowJob[] =
    includeJobs && Array.isArray(data.jobs) ?
      data.jobs.filter(
        (job): job is WorkflowJob =>
          job !== null && typeof job === "object" && !Array.isArray(job)
      )
    : [];
  const steps: WorkflowStep[] = [];
  for (const job of jobs) {
    for (const step of job.steps || []) {
      steps.push({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion
      });
    }
  }
  return {
    status: typeof data.status === "string" ? data.status : undefined,
    conclusion:
      typeof data.conclusion === "string" || data.conclusion === null ?
        data.conclusion
      : undefined,
    jobs,
    steps
  };
}
