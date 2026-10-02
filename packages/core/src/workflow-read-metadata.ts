export type WorkflowReadTiming =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "delay"; milliseconds: number }
  | { state: "deadline"; epochMilliseconds: number };

export type WorkflowResponseMetadata =
  | {
      source: "unavailable";
      reason:
        "opaque-command" | "invalid-response" | "timeout" | "output-limit";
    }
  | {
      source: "gh-api-include";
      status: number;
      receivedAtEpochMilliseconds: number;
      retryAfter: WorkflowReadTiming;
      rateLimitReset: WorkflowReadTiming;
      serverDate: WorkflowReadTiming;
      rateLimitRemaining: number | null;
      classification: "authorization" | "rate-limit" | "other";
    };

export interface WorkflowReadEvidence {
  phase: "run" | "jobs" | "repository" | "artifacts";
  response: WorkflowResponseMetadata;
}
