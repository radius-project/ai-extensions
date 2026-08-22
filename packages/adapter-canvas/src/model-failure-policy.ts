// Single source of truth for which .radius/app.bicep failures the agent should
// repair and which it must not. The graph classifier matches Bicep compiler
// output against these patterns, and the deploy repair prompt states the same
// policy in prose, so both must describe the same set of failures. Keeping the
// prose and the patterns in one place is what stops them from drifting: adding
// a category here updates the classifier and the prompt together.

export interface ModelFailureCategory {
  // Prose fragment naming the category in an agent-facing prompt.
  readonly summary: string;
  // Compiler-output patterns that identify the category, empty when the
  // category only ever shows up at deploy time and has no compile signature.
  readonly patterns: readonly RegExp[];
}

// Failures caused by the application model itself. The agent may repair these.
export const MODEL_FAILURE_CATEGORIES: readonly ModelFailureCategory[] = [
  {
    summary: "an unknown or unsupported resource type",
    patterns: [
      /\b(?:invalid|unknown|unrecognized|unsupported)\s+resource type\b/iu,
      /\bresource type\b[^\r\n]*\b(?:invalid|not recognized|not supported|unknown)\b/iu
    ]
  },
  {
    summary: "an unknown or unsupported API version",
    patterns: [
      /\b(?:invalid|unknown|unsupported)\s+api(?: |-)?version\b/iu,
      /\bapi(?: |-)?version\b[^\r\n]*\b(?:invalid|not recognized|not supported|unknown)\b/iu
    ]
  },
  {
    summary: "an unknown, missing, or disallowed property",
    patterns: [
      /\b(?:invalid|missing|unknown)\s+(?:required\s+)?propert(?:y|ies)\b/iu,
      /\bpropert(?:y|ies)\b[^\r\n]*\b(?:does not exist|is not allowed|is not permitted|is invalid)\b/iu
    ]
  },
  {
    summary: "an invalid reference between resources",
    patterns: [
      /\binvalid (?:resource )?reference\b/iu,
      /\breferenced (?:declaration|resource)\b[^\r\n]*\b(?:does not exist|invalid|not found|not valid)\b/iu
    ]
  },
  {
    summary: "a wrong credential shape",
    patterns: [
      /\bcredentials?\b[^\r\n]*\b(?:expected|must be|required to be|should be)\b[^\r\n]*\b(?:array|map|object|string)\b/iu
    ]
  },
  {
    summary: "a Bicep parse or compile error",
    patterns: [
      /\bbicep\b[^\r\n]*\b(?:compilation|compile|parse|parsing)\b[^\r\n]*\b(?:error|failed|failure)\b/iu,
      /\b(?:failed|unable) to (?:compile|parse)\b[^\r\n]*\.bicep\b/iu
    ]
  }
];

// Failures the application model cannot cause. Repairing the model for these
// would waste the attempt budget on a problem the edit cannot reach, so the
// classifier refuses them and the deploy prompt tells the agent to stop.
export const INFRASTRUCTURE_FAILURE_CATEGORIES: readonly ModelFailureCategory[] =
  [
    {
      summary: "an unresolved Radius Bicep extension",
      patterns: [
        /\bBCP204\b/u,
        /\bextension\s+["']?radius["']?\s+is not recognized\b/iu,
        /\b(?:failed|unable) to (?:download|resolve|restore)\b[^\r\n]*\bextension\b/iu
      ]
    },
    { summary: "recipe download or execution", patterns: [] },
    {
      summary:
        "provider mismatch, cluster, credential, or connectivity problems",
      patterns: []
    }
  ];

export const MODEL_FAILURE_PATTERNS: readonly RegExp[] =
  MODEL_FAILURE_CATEGORIES.flatMap((category) => [...category.patterns]);

export const INFRASTRUCTURE_FAILURE_PATTERNS: readonly RegExp[] =
  INFRASTRUCTURE_FAILURE_CATEGORIES.flatMap((category) => [
    ...category.patterns
  ]);

function joinSummaries(
  summaries: readonly string[],
  conjunction: string
): string {
  if (summaries.length <= 1) return summaries.join("");
  const last = summaries[summaries.length - 1];
  return `${summaries.slice(0, -1).join(", ")}, ${conjunction} ${last}`;
}

// Exported for the policy's own tests: the shipped lists always have several
// entries, so the single-entry shape is only reachable directly.
export function formatSummaryList(
  categories: readonly ModelFailureCategory[],
  conjunction = "or"
): string {
  return joinSummaries(
    categories.map((category) => category.summary),
    conjunction
  );
}

export function modelFailureSummaryList(): string {
  return formatSummaryList(MODEL_FAILURE_CATEGORIES);
}

export function infrastructureFailureSummaryList(): string {
  return formatSummaryList(INFRASTRUCTURE_FAILURE_CATEGORIES);
}
