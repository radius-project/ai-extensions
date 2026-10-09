import type { WorkflowJob } from "@radius-project/core";

export const pendingEnvironment = {
  environment: { id: 1, name: "production <review>" },
  wait_timer: 0,
  wait_timer_started_at: null,
  current_user_can_approve: false,
  reviewers: [{ type: "User", reviewer: { id: 1 } }]
};

export const workflowObservationCases: {
  name: string;
  status: string;
  conclusion: string | null;
  jobs: WorkflowJob[];
  jobsTotal?: number;
  pending: unknown;
  protectionStatus: number;
  protectionState?: "observed" | "unavailable";
}[] = [
  ...["success", "failure", "cancelled", "future_conclusion"].map(
    (conclusion) => ({
      name: conclusion,
      status: "completed",
      conclusion,
      jobs: [],
      pending: [],
      protectionStatus: 200
    })
  ),
  {
    name: "combined primary and teardown failure",
    status: "completed",
    conclusion: "failure",
    jobs: [
      {
        name: "deploy",
        steps: [
          {
            name: "Run rad commands",
            status: "completed",
            conclusion: "failure"
          },
          { name: "Teardown", status: "completed", conclusion: "failure" }
        ]
      }
    ],
    pending: [],
    protectionStatus: 200
  },
  {
    name: "incomplete waiting jobs",
    status: "waiting",
    conclusion: null,
    jobs: [],
    jobsTotal: 1,
    pending: [],
    protectionStatus: 200,
    protectionState: "unavailable"
  },
  {
    name: "post-deployment teardown failure",
    status: "completed",
    conclusion: "failure",
    jobs: [
      {
        name: "deploy",
        steps: [
          {
            name: "Run rad commands",
            status: "completed",
            conclusion: "success"
          },
          { name: "Teardown", status: "completed", conclusion: "failure" }
        ]
      }
    ],
    pending: [],
    protectionStatus: 200
  },
  ...[
    { name: "reviewers", pending: [pendingEnvironment] },
    {
      name: "timer",
      pending: [{ ...pendingEnvironment, reviewers: [], wait_timer: 30 }]
    },
    {
      name: "both",
      pending: [
        { ...pendingEnvironment, wait_timer: 1, current_user_can_approve: true }
      ]
    },
    { name: "empty", pending: [] }
  ].map((entry) => ({
    ...entry,
    status: "waiting",
    conclusion: null,
    jobs: [],
    protectionStatus: 200,
    protectionState: "observed" as const
  })),
  {
    name: "malformed protection",
    status: "waiting",
    conclusion: null,
    jobs: [],
    pending: [null],
    protectionStatus: 200,
    protectionState: "unavailable"
  },
  {
    name: "unreadable protection",
    status: "waiting",
    conclusion: null,
    jobs: [],
    pending: { message: "Forbidden" },
    protectionStatus: 403,
    protectionState: "unavailable"
  }
];
