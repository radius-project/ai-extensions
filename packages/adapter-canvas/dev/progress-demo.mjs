// A runnable demonstration of the environment-creation progress UX.
//
// Starts the real canvas server, renders the real environment page, and drives a
// real `OperationRecord` through the real `/api/operations` route, so what you
// watch is the product's own markup, CSS, poller and record model. The only
// thing simulated is the cloud: no App Registration is created, no role is
// assigned, no GitHub environment is written.
//
// That boundary is the point. Looking at a progress panel should not require
// provisioning an identity in somebody's tenant, and the panel cannot tell the
// difference — it only ever sees the record.
//
//   pnpm demo:progress
//
// The demo cycles through the four terminal states the design introduces, then
// loops. Watch for:
//
//   * the panel is inline and non-blocking — the page stays usable throughout
//   * reloading mid-run re-attaches to the operation instead of losing it
//   * the "action required" scenario, which is the outcome that used to be
//     reported as an eight-minute timeout
//   * the status chip in the top navigation once you leave the environment page
//
import {
  addLegacyStep,
  buildStages,
  createOperation,
  enterStage,
  finish,
  finishSucceeded,
  operations,
  setCloudContext,
  setContext,
  setStageState,
  STAGE_AUTHORIZE_IDENTITY,
  STAGE_CONFIGURE_ENVIRONMENT,
  STAGE_VERIFY
} from "../src/operations.js";
import { getOrCreateServer } from "../src/server.js";

const REPO = process.env.RADIUS_DEMO_REPO || "radius-project/ai-extensions";
const ENV_NAME = process.env.RADIUS_DEMO_ENV || "dev";
// Slow enough to read, fast enough to sit through. A real setup is 1-8 minutes.
const BEAT_MS = Number(process.env.RADIUS_DEMO_BEAT_MS || 1400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The step strings are copied from the real routes, markers and all, so the
// demo exercises the same `addLegacyStep` inference the product depends on.
const IDENTITY_STEPS = [
  "Acting on GitHub as @ryanwaite.",
  "Checking Azure CLI login...",
  "✅ Using subscription=8f4e2b1c-…-9d3a, tenant=72f988bf-…-2d7cd011db47",
  "Resolving GitHub OIDC subject...",
  "✅ OIDC subject(s): repo:radius-project/ai-extensions:environment:dev",
  "Creating App Registration: radius-deploy-radius-project-ai-extensions...",
  "✅ App Registration created: 6b1f0c9a-…-4e77",
  "Creating Service Principal...",
  "✅ Service Principal ready",
  'Creating federated credential "radius-dev-env"...',
  '✅ Federated credential "radius-dev-env" created',
  "Assigning Contributor role on rg-radius-demo...",
  "✅ Contributor role assigned"
];

const ENVIRONMENT_STEPS = [
  'Creating private GHCR state package "radius-project/ai-extensions/dev-state"...',
  "✅ GHCR state package is private and linked to radius-project/ai-extensions.",
  'Creating GitHub environment "dev"...',
  "Setting environment secrets...",
  "Set 4 environment value(s) for Azure.",
  "Committing verify-credentials workflow...",
  "Committing deploy workflow..."
];

/** @type {Record<string, {label: string, run: (op: any) => Promise<void>}>} */
const SCENARIOS = {
  // The ordinary outcome. Everything the user asked for happened.
  succeeded: {
    label:
      "Happy path — identity created, environment configured, credentials verified",
    async run(op) {
      await playStage(op, STAGE_AUTHORIZE_IDENTITY, IDENTITY_STEPS);
      await playStage(op, STAGE_CONFIGURE_ENVIRONMENT, ENVIRONMENT_STEPS);
      await playStage(op, STAGE_VERIFY, [
        "Dispatching verify-credentials workflow...",
        "Verify run: https://github.com/radius-project/ai-extensions/actions/runs/1234567890",
        "✅ Credentials verified."
      ]);
      finishSucceeded(op, {
        reason: "verified",
        userMessage: `Environment "${ENV_NAME}" is ready. Deploy your application from the Deploy tab.`
      });
    }
  },

  // Everything the user asked for happened, but one grant needs a human. The
  // operation succeeded; saying otherwise would be as wrong as hiding it.
  succeeded_with_warnings: {
    label:
      "Succeeded with a warning — the AKS role grant needs an administrator",
    async run(op) {
      await playStage(op, STAGE_AUTHORIZE_IDENTITY, [
        ...IDENTITY_STEPS,
        "Assigning Azure Kubernetes Service RBAC Cluster Admin on aks-radius-demo...",
        "⚠️ Could not assign the AKS RBAC Cluster Admin role automatically. Deploys will fail if the cluster uses Azure RBAC for Kubernetes."
      ]);
      await playStage(op, STAGE_CONFIGURE_ENVIRONMENT, ENVIRONMENT_STEPS);
      await playStage(op, STAGE_VERIFY, [
        "Dispatching verify-credentials workflow...",
        "✅ Credentials verified."
      ]);
      finishSucceeded(op, {
        reason: "verified-with-warnings",
        userMessage: `Environment "${ENV_NAME}" is ready, but one role grant needs an administrator.`
      });
    }
  },

  // The defect this design was partly written to expose. Setup could not push
  // to the default branch, so it opened a pull request and deliberately did
  // NOT dispatch verification -- the workflow only exists on the PR branch.
  // Before Phase 1b the client polled anyway and called this a timeout after
  // eight minutes. It is not a failure; it is a correct outcome that needs one
  // more action from the user.
  action_required: {
    label: "Action required — no push access, so setup opened a pull request",
    async run(op) {
      await playStage(op, STAGE_AUTHORIZE_IDENTITY, IDENTITY_STEPS);
      await playStage(op, STAGE_CONFIGURE_ENVIRONMENT, [
        ...ENVIRONMENT_STEPS.slice(0, 4),
        'ℹ️ No permission to push to "main" directly — committing workflows to branch "radius-setup-dev" and opening a pull request.',
        "👉 Merge the pull request to finish setup."
      ]);
      addLegacyStep(
        op,
        "⏭️ Skipping credential verification until the pull request is merged.",
        STAGE_VERIFY
      );
      setStageState(op, STAGE_VERIFY, "skipped");
      // Same payload shape the real route builds, so the panel renders the
      // pull-request link through the production code path.
      finish(op, "action_required", {
        terminal: {
          reason: "pr-merge-required",
          pullRequestUrl:
            "https://github.com/radius-project/ai-extensions/pull/244",
          userMessage:
            "Merge the pull request to finish setup; credential verification and deploys run once it lands."
        }
      });
    }
  },

  // A hard stop. The panel must keep the step history on screen: what already
  // happened is exactly what the user needs to know before retrying.
  failed: {
    label: "Failed — the tenant blocks App Registration creation",
    async run(op) {
      await playStage(op, STAGE_AUTHORIZE_IDENTITY, IDENTITY_STEPS.slice(0, 5));
      addLegacyStep(
        op,
        "Creating App Registration: radius-deploy-radius-project-ai-extensions..."
      );
      await sleep(BEAT_MS);
      addLegacyStep(op, "❌ Could not create the App Registration.");
      setStageState(op, STAGE_AUTHORIZE_IDENTITY, "failed");
      // The real route's failure shape. `evidence` is raw command output,
      // which toClientView strips before the record reaches the webview --
      // the canary below should never appear in the browser.
      finish(op, "failed", {
        failure: {
          code: "app-registration-forbidden",
          stage: STAGE_AUTHORIZE_IDENTITY,
          message:
            "Your tenant does not allow creating App Registrations. Ask a Microsoft Entra administrator to create one, then select it above.",
          classification: "needs-someone-else",
          evidence: "DEMO-EVIDENCE-SHOULD-NEVER-REACH-THE-BROWSER"
        }
      });
    }
  }
};

async function playStage(op, stageId, steps) {
  enterStage(op, stageId);
  for (const step of steps) {
    addLegacyStep(op, step);
    await sleep(BEAT_MS);
  }
}

function seed(scenarioKey) {
  const op = createOperation({
    provider: "azure",
    repo: REPO,
    environment: ENV_NAME,
    stages: buildStages(),
    journey: {
      origin: { page: "planned", repo: REPO },
      // The PM's point made concrete: environment creation is a subroutine
      // of planning, so the record remembers where to send the user back.
      resumeTarget: { page: "planned", repo: REPO },
      resumeReason: "Return to your planned application graph"
    }
  });
  setContext(op, { githubLogin: "ryanwaite" });
  setCloudContext(op, "azure", {
    subscriptionId: "8f4e2b1c-0000-0000-0000-000000009d3a",
    tenantId: "72f988bf-0000-0000-0000-00002d7cd011db47",
    resourceGroup: "rg-radius-demo"
  });
  const started = operations.start(op);
  if (!started.ok) {
    // Only reachable if a previous scenario is still running.
    throw new Error(
      `could not start ${scenarioKey}: an operation is already in flight`
    );
  }
  return op;
}

async function main() {
  const entry = await getOrCreateServer("progress-demo", "environment");
  // The environment page reads its repo out of the server entry's state, the
  // same field the extension populates when it opens the canvas.
  entry.state.contextRepo = REPO;
  entry.state.targetRepo = REPO;

  const url = `${entry.baseUrl}/?page=environment`;
  const order =
    process.env.RADIUS_DEMO_SCENARIO ?
      [process.env.RADIUS_DEMO_SCENARIO]
    : ["succeeded", "action_required", "succeeded_with_warnings", "failed"];

  console.log("");
  console.log("  Radius progress UX demo");
  console.log("  " + "-".repeat(58));
  console.log(`  Open:  ${url}`);
  console.log(`  Repo:  ${REPO}    Environment: ${ENV_NAME}`);
  console.log("");
  console.log("  Real server, real page, real record. The cloud is simulated.");
  console.log(
    "  Reload the page mid-run: the panel re-attaches to the operation."
  );
  console.log("  Switch to another tab: the status chip follows you.");
  console.log("  Ctrl-C to stop.");
  console.log("");

  for (let cycle = 1; ; cycle++) {
    for (const key of order) {
      const scenario = SCENARIOS[key];
      if (!scenario) {
        console.error(
          `  unknown scenario "${key}"; expected one of ${Object.keys(
            SCENARIOS
          ).join(", ")}`
        );
        process.exit(1);
      }
      console.log(`  [${cycle}] ${key} — ${scenario.label}`);
      const op = seed(key);
      await scenario.run(op);
      console.log(
        `      → ${op.state}${
          op.terminal?.userMessage ? `: ${op.terminal.userMessage}` : ""
        }${op.failure?.message ? `: ${op.failure.message}` : ""}`
      );
      // Leave the terminal result on screen long enough to read it, which
      // is also what the real panel does: a finished operation does not
      // clear itself out from under the user.
      await sleep(6000);
      operations.clear();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
