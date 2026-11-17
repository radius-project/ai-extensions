// A small IAM policy evaluator for the policies the Cloud E2E setup and the
// product write. It follows the IAM policy evaluation logic for a request
// inside one account with no resource-based, session, or organization
// policies:
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html
//
//   - An explicit Deny in any policy wins.
//   - Otherwise an identity policy must allow the request, and, when the role
//     has a permissions boundary, so must the boundary.
//
// It knows only the policy elements and condition operators these policies
// use, and throws on anything else, so a policy that grows past it fails a
// test instead of evaluating wrongly.

export type IamDecision = "allowed" | "explicitDeny" | "implicitDeny";

export interface IamRequest {
  readonly action: string;
  readonly resource: string;
  // Request context keys, such as aws:RequestedRegion. Key names ignore case.
  readonly context?: Readonly<Record<string, string>>;
}

interface Statement {
  readonly Effect: string;
  readonly Action?: string | string[];
  readonly NotAction?: string | string[];
  readonly Resource?: string | string[];
  readonly NotResource?: string | string[];
  readonly Condition?: Record<string, Record<string, string | string[]>>;
}

const KNOWN_ELEMENTS = new Set([
  "Sid",
  "Effect",
  "Action",
  "NotAction",
  "Resource",
  "NotResource",
  "Condition"
]);

function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// `*` matches any run of characters, including `/`, and `?` any one.
function wildcard(
  pattern: string,
  value: string,
  ignoreCase: boolean
): boolean {
  const source = pattern
    .split("")
    .map((char) =>
      char === "*" ? ".*"
      : char === "?" ? "."
      : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    )
    .join("");
  return new RegExp(`^${source}$`, ignoreCase ? "is" : "s").test(value);
}

// Condition operators, from
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition_operators.html
// A positive operator is false when the key is missing. A negated one is
// true when the key is missing.
const OPERATORS: Record<
  string,
  { negated: boolean; match: (pattern: string, value: string) => boolean }
> = {
  StringEquals: { negated: false, match: (p, v) => p === v },
  StringNotEquals: { negated: true, match: (p, v) => p === v },
  StringLike: { negated: false, match: (p, v) => wildcard(p, v, false) },
  StringNotLike: { negated: true, match: (p, v) => wildcard(p, v, false) },
  ArnLike: { negated: false, match: (p, v) => wildcard(p, v, false) },
  ArnNotLike: { negated: true, match: (p, v) => wildcard(p, v, false) }
};

function contextValue(
  context: Readonly<Record<string, string>>,
  key: string
): string | undefined {
  const name = Object.keys(context).find(
    (item) => item.toLowerCase() === key.toLowerCase()
  );
  return name === undefined ? undefined : context[name];
}

function conditionHolds(
  condition: Statement["Condition"],
  context: Readonly<Record<string, string>>
): boolean {
  for (const [operator, keys] of Object.entries(condition ?? {})) {
    const known = OPERATORS[operator];
    if (!known)
      throw new Error(`The IAM evaluator does not know operator ${operator}.`);
    for (const [key, patterns] of Object.entries(keys)) {
      const value = contextValue(context, key);
      const matched =
        value !== undefined &&
        list(patterns).some((pattern) => known.match(pattern, value));
      if (known.negated ? matched : !matched) return false;
    }
  }
  return true;
}

function statementMatches(statement: Statement, request: IamRequest): boolean {
  for (const element of Object.keys(statement))
    if (!KNOWN_ELEMENTS.has(element))
      throw new Error(`The IAM evaluator does not know element ${element}.`);
  if ((statement.Action === undefined) === (statement.NotAction === undefined))
    throw new Error("A statement needs exactly one of Action and NotAction.");
  if (
    (statement.Resource === undefined) ===
    (statement.NotResource === undefined)
  )
    throw new Error(
      "A statement needs exactly one of Resource and NotResource."
    );
  // Action names ignore case. Resource ARNs don't.
  const action =
    statement.Action !== undefined ?
      list(statement.Action).some((p) => wildcard(p, request.action, true))
    : !list(statement.NotAction).some((p) => wildcard(p, request.action, true));
  const resource =
    statement.Resource !== undefined ?
      list(statement.Resource).some((p) => wildcard(p, request.resource, false))
    : !list(statement.NotResource).some((p) =>
        wildcard(p, request.resource, false)
      );
  return (
    action &&
    resource &&
    conditionHolds(statement.Condition, request.context ?? {})
  );
}

function statements(policy: unknown): Statement[] {
  const value = (policy as { Statement?: unknown } | null)?.Statement;
  if (Array.isArray(value)) return value as Statement[];
  if (value && typeof value === "object") return [value as Statement];
  throw new Error("An IAM policy needs a Statement.");
}

function decide(
  policies: readonly unknown[],
  request: IamRequest
): IamDecision {
  let allowed = false;
  for (const policy of policies) {
    for (const statement of statements(policy)) {
      if (!statementMatches(statement, request)) continue;
      if (statement.Effect === "Deny") return "explicitDeny";
      if (statement.Effect !== "Allow")
        throw new Error(`Unknown Effect ${statement.Effect}.`);
      allowed = true;
    }
  }
  return allowed ? "allowed" : "implicitDeny";
}

/**
 * The decision for `request` by a principal with `identity` policies and,
 * when it has one, a permissions `boundary`.
 */
export function evaluateIam(
  request: IamRequest,
  identity: readonly unknown[],
  boundary?: unknown
): IamDecision {
  const own = decide(identity, request);
  if (boundary === undefined || own === "explicitDeny") return own;
  const capped = decide([boundary], request);
  if (capped === "explicitDeny") return capped;
  return own === "allowed" && capped === "allowed" ? "allowed" : "implicitDeny";
}
