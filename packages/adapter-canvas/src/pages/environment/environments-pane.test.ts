import { describe, it, expect } from "vitest";
import {
  unlabelledSelectIds,
  unlabelledTextInputIds
} from "../../../test/support/pages/labelled-controls.js";
import { environmentsPaneMarkup } from "./environments-pane.js";

const baseOptions = {
  activeSubtab: "environments",
  envName: "dev",
  ctxRepo: "octo/app",
  deployDefaultBranch: "feature/x"
};

describe("environmentsPaneMarkup", () => {
  it("gives every selector in the create form a programmatic name", () => {
    expect(unlabelledSelectIds(environmentsPaneMarkup(baseOptions))).toEqual(
      []
    );
  });

  // The discovery selects and their "__custom__" free-text inputs sit in the
  // same field, so a <label for="...-select"> names the select and leaves the
  // input unnamed once it is revealed. Assert the whole set, not one control.
  it("gives every text input in the create form a programmatic name", () => {
    expect(unlabelledTextInputIds(environmentsPaneMarkup(baseOptions))).toEqual(
      []
    );
  });

  it("names each custom infrastructure input independently of its select", () => {
    const html = environmentsPaneMarkup(baseOptions);
    for (const [id, name] of [
      ["azure-rg-custom", "Resource Group (custom)"],
      ["azure-cluster-custom", "Cluster (custom)"],
      ["azure-namespace-custom", "Namespace (custom)"],
      ["aws-cluster-custom", "EKS Cluster (custom)"],
      ["aws-namespace-custom", "Namespace (custom)"],
      ["aws-vpc-custom", "VPC (custom)"],
      ["aws-subnets-custom", "Subnets (custom)"]
    ]) {
      const tag = new RegExp(`<input id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
      expect(tag, `${id} should be rendered`).not.toBe("");
      expect(tag).toContain(`aria-label="${name}"`);
    }
  });

  it("renders one visible section when the environments sub-tab is active", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain('<section id="pane-environments" style="">');
    // The GitHub repair block must sit outside the technical-details
    // disclosure, otherwise the fix is only visible to a user who thinks to
    // expand it.
    const repairAt = html.indexOf('id="env-gh-repair"');
    const detailsAt = html.indexOf('id="env-gh-details-panel"');
    expect(repairAt).toBeGreaterThan(-1);
    expect(repairAt).toBeLessThan(detailsAt);
    expect(html).not.toContain("env-gh-fix-access");
    expect(html.trimEnd().endsWith("</section>")).toBe(true);
  });

  it("hides the section when another sub-tab is active", () => {
    expect(
      environmentsPaneMarkup({ ...baseOptions, activeSubtab: "credentials" })
    ).toContain('<section id="pane-environments" style="display:none;">');
  });

  it("carries the environment name, repository and branch into the create form", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain('id="env-name-input"');
    expect(html).toContain('value="dev"');
    expect(html).toContain(
      '<input type="hidden" id="target-repo" value="octo/app" />'
    );
    expect(html).toContain(
      '<input type="hidden" id="deploy-branch-select" value="feature/x" />'
    );
  });

  it("defaults the hidden branch to main when the session branch is unknown", () => {
    const html = environmentsPaneMarkup({
      ...baseOptions,
      deployDefaultBranch: ""
    });
    expect(html).toContain(
      '<input type="hidden" id="deploy-branch-select" value="main" />'
    );
  });

  it("derives the deploy identity name from the repository", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain('value="radius-deploy-octo-app"');
    expect(html).toContain('data-default-name="radius-deploy-octo-app"');
    expect(html).toContain("<code>repo:octo/app</code>");
  });

  it("keeps the identity name usable when no repository is known", () => {
    const html = environmentsPaneMarkup({ ...baseOptions, ctxRepo: "" });
    expect(html).toContain('value="radius-deploy-"');
    expect(html).toContain('data-default-name="radius-deploy-"');
  });

  it("escapes every state value it renders into an attribute", () => {
    const hostile = "a/<img src=x>'\"&";
    const html = environmentsPaneMarkup({
      activeSubtab: "environments",
      envName: hostile,
      ctxRepo: hostile,
      deployDefaultBranch: hostile
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain('value="a/&lt;img src=x&gt;&#39;&quot;&amp;"');
    expect(html).toContain(
      'value="radius-deploy-a-&lt;img src=x&gt;&#39;&quot;&amp;"'
    );
  });

  it("renders the progress panel above the table without an overlay", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain('id="env-progress-panel"');
    expect(html.indexOf('id="env-progress-panel"')).toBeLessThan(
      html.indexOf('id="new-env-btn"')
    );
    expect(html).toContain(
      'role="region" aria-label="Environment setup progress" tabindex="-1"'
    );
    expect(html).toContain(
      'id="env-progress-elapsed" class="env-progress__elapsed" role="timer" aria-label="Elapsed time"'
    );
  });

  it("associates the environment label with its input", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain(
      '<label for="env-name-input">Environment name</label>'
    );
  });

  it("renders an accessible operation command region with stable ids", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain('id="env-progress-commands"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Environment setup controls"');
    expect(html).toContain(
      'id="env-progress-elapsed" class="env-progress__elapsed" role="timer" aria-label="Elapsed time"'
    );
    expect(html).toContain('id="env-progress-command-buttons"');
    expect(html).toContain('id="env-progress-command-descriptions"');
    expect(html).toContain(
      '<div id="env-progress-command-status" class="env-progress__command-status" role="status" aria-live="polite"></div>'
    );
    expect(html).toContain(
      '<div id="env-progress-command-error" class="env-progress__command-error" role="alert"></div>'
    );
  });

  it("renders an accessible diagnostic review inside operation details", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html.indexOf('id="env-progress-diagnostics"')).toBeGreaterThan(
      html.indexOf('id="env-progress-details"')
    );
    expect(html).toContain(
      'id="env-progress-diagnostics-open" class="rad-btn rad-btn--secondary" aria-describedby="env-progress-diagnostics-note"'
    );
    expect(html).toContain(">Download diagnostic snapshot</button>");
    expect(html).toContain(
      "Captures this paused or completed state in a local, redacted JSON file. Radius does not upload it."
    );
    expect(html).toContain(
      'id="env-diagnostics-modal" role="dialog" aria-modal="true" aria-labelledby="env-diagnostics-title" aria-describedby="env-diagnostics-intro"'
    );
    expect(html).toContain(
      '<label for="env-diagnostics-include-identifiers">Include contextual identifiers</label>'
    );
    expect(html).toContain(
      '<label for="env-diagnostics-reviewed-identifiers">I reviewed these identifiers</label>'
    );
    expect(html).toContain(
      'id="env-diagnostics-download" class="rad-btn rad-btn--primary" href="" download="radius-environment-operation-diagnostics.json" aria-disabled="true"'
    );
  });

  it("renders the five partial-state groups as separate named blocks", () => {
    const html = environmentsPaneMarkup(baseOptions);
    for (const id of [
      "env-progress-state-created",
      "env-progress-state-retained",
      "env-progress-state-reused",
      "env-progress-state-cleaned",
      "env-progress-state-manual"
    ]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`id="${id}-block"`);
    }
    expect(html).toContain("Reused — not created by this attempt");
    expect(html).toContain("Needs an action from you");
  });

  it("closes the progress panel from a bottom row below the details", () => {
    const html = environmentsPaneMarkup(baseOptions);
    // The bottom row is the last thing in the panel, under "Show details". It
    // holds the server-projected way out — rendered into the empty container —
    // and the acknowledgement an already-settled outcome closes on.
    expect(html.indexOf('id="env-progress-details"')).toBeLessThan(
      html.indexOf('id="env-progress-actions"')
    );
    expect(html.indexOf('id="env-progress-actions"')).toBeLessThan(
      html.indexOf('id="env-progress-bottom-buttons"')
    );
    expect(html.indexOf('id="env-progress-bottom-buttons"')).toBeLessThan(
      html.indexOf('id="env-progress-dismiss"')
    );
    const actions = html.slice(
      html.indexOf('id="env-progress-actions"'),
      html.indexOf('id="env-diagnostics-modal"')
    );
    expect(actions).toContain(
      '<div id="env-progress-bottom-buttons" class="env-progress__bottom-buttons"></div>'
    );
    expect(actions).toContain(
      'aria-label="Dismiss completed environment setup progress"'
    );
    // Only the acknowledgement is static: every other control in this row is
    // whatever the operation record projected.
    expect(actions.match(/<button/g) ?? []).toHaveLength(1);
    expect(actions).not.toContain("<a ");
  });

  it("never offers planned-graph navigation from the progress panel", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).not.toContain('id="env-progress-resume"');
    expect(html).not.toContain("View planned graph");
  });

  it("splits creation into a credentials step followed by an environment step", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain('id="env-wizard-steps"');
    expect(html.indexOf('id="env-step-credentials"')).toBeLessThan(
      html.indexOf('id="env-step-details"')
    );
    // Step 1 is the entry point, so only step 2 starts hidden.
    expect(html).toContain('<div id="env-step-credentials">');
    expect(html).toContain('<div id="env-step-details" style="display:none;">');
  });

  it("marks step 1 as the current step and step 2 as pending", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toMatch(
      /id="env-wizard-step-1"[^>]*data-step="1" aria-current="step"/
    );
    expect(html).toContain(
      'class="rad-wizard__step rad-wizard__step--active" id="env-wizard-step-1"'
    );
    expect(html).toContain(
      '<li class="rad-wizard__step" id="env-wizard-step-2" data-step="2">'
    );
  });

  it("numbers the wizard only in the stepper, not again in the card titles", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain(
      '<div class="rad-card__title" style="margin:0;">Choose cloud credentials</div>'
    );
    expect(html).toContain(
      '<div class="rad-card__title" id="env-step2-title" style="margin:0;">Create Environment</div>'
    );
    // The stepper above the cards already carries the ordinals, so repeating
    // "Step N" in a title would number the same thing twice.
    const titles = [
      ...html.matchAll(/class="rad-card__title"[^>]*>([^<]*)</g)
    ].map((match) => match[1]);
    expect(titles).toContain("Choose cloud credentials");
    expect(titles).toContain("Create Environment");
    for (const title of titles) expect(title).not.toMatch(/step/i);
  });

  it("chooses the credential profile in step 1, including creating a new one", () => {
    const html = environmentsPaneMarkup(baseOptions);
    const stepOne = html.slice(
      html.indexOf('id="env-step-credentials"'),
      html.indexOf('id="env-step-details"')
    );
    expect(stepOne).toContain('id="env-profile-combo"');
    expect(stepOne).toContain('id="env-profile-select"');
    expect(stepOne).toContain('id="env-create-profile-link"');
    expect(stepOne).toContain('id="env-cred-form-host"');
  });

  it("gates the step 1 continue action until a profile is selected", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toMatch(/id="env-step1-next"[^>]*disabled/);
    expect(html).toContain('id="env-step1-hint"');
  });

  it("echoes the chosen profile in step 2 with a way back to change it", () => {
    const html = environmentsPaneMarkup(baseOptions);
    const stepTwo = html.slice(html.indexOf('id="env-step-details"'));
    expect(stepTwo).toContain('id="env-profile-summary"');
    expect(stepTwo).toContain('id="env-change-profile-link"');
    expect(stepTwo).toContain('id="env-profile-detail"');
    expect(stepTwo).toContain('id="env-step2-back"');
    // The combo itself belongs to step 1; step 2 only reflects the choice.
    expect(stepTwo).not.toContain('id="env-profile-combo"');
  });

  it("keeps leaving the wizard available from either step", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html.indexOf('id="cancel-env-btn"')).toBeLessThan(
      html.indexOf('id="env-step-credentials"')
    );
  });

  it("keeps the environment details and their step numbering in step 2", () => {
    const html = environmentsPaneMarkup(baseOptions);
    const stepTwo = html.slice(html.indexOf('id="env-step-details"'));
    for (const title of [
      "1 · Name this environment",
      "2 · Connect GitHub to a cloud",
      "3 · Deploy identity",
      "4 · Infrastructure"
    ]) {
      expect(stepTwo).toContain(title);
    }
    expect(stepTwo).toContain('id="deploy-btn"');
  });

  it("presents the two connection sides as one trust, not a choice", () => {
    const html = environmentsPaneMarkup(baseOptions);
    const conn = html.slice(html.indexOf('class="rad-conn"'));
    const github = conn.indexOf("GitHub");
    const cloud = conn.indexOf("Cloud credentials");
    expect(github).toBeGreaterThan(-1);
    expect(cloud).toBeGreaterThan(github);
    // The cloud side only echoes the profile chosen in step 1, so it carries no
    // ordinal of its own.
    expect(conn).not.toContain("rad-conn__ord");
    expect(html).toContain(
      "These are the two ends of that trust, not a choice between them: the cloud credentials are the profile you selected, shown here to confirm."
    );
  });
});

describe("environmentsPaneMarkup — stop, continue and rollback", () => {
  const html = environmentsPaneMarkup(baseOptions);

  it("gives the stopped and rollback states their own heading line", () => {
    expect(html).toContain(
      '<div id="env-progress-headline-note" class="env-progress__headline-note" style="display:none;"></div>'
    );
    expect(html).toContain('id="env-progress-failure-title"');
  });

  it("renders a guidance list for a path Radius cannot offer", () => {
    expect(html).toContain(
      '<ul id="env-progress-command-guidance" class="env-progress__command-guidance" style="display:none;"></ul>'
    );
  });

  it("declares the rollback confirmation as an accessible modal dialog", () => {
    expect(html).toContain(
      '<div id="env-rollback-modal" role="dialog" aria-modal="true" aria-labelledby="env-rollback-title" aria-describedby="env-rollback-intro"'
    );
    expect(html).toContain(
      '<div id="env-rollback-title" class="env-rollback__title" tabindex="-1">Roll back resources created by this setup?</div>'
    );
    // Hidden until the customer asks for it, so nothing destructive is one
    // stray click away.
    const dialog = html.slice(html.indexOf('id="env-rollback-modal"'));
    expect(dialog.slice(0, 260)).toContain("display:none;");
  });

  it("names the destructive confirmation and the safe way out", () => {
    expect(html).toContain(
      '<button type="button" id="env-rollback-cancel" class="rad-btn rad-btn--neutral" style="margin:0;">Keep resources</button>'
    );
    expect(html).toContain(
      '<button type="button" id="env-rollback-confirm" class="rad-btn rad-btn--danger" style="margin:0;">Roll back resources</button>'
    );
    // Cancel comes first in the DOM, so the destructive control is never the
    // first thing a keyboard user lands on after the title.
    expect(html.indexOf('id="env-rollback-cancel"')).toBeLessThan(
      html.indexOf('id="env-rollback-confirm"')
    );
  });

  it("carries a named block for each preview group the server projects", () => {
    for (const id of [
      "env-rollback-remove",
      "env-rollback-keep",
      "env-rollback-manual"
    ]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`id="${id}-block"`);
    }
    expect(html).toContain("Radius will remove");
    expect(html).toContain("Radius will keep");
  });

  it("keeps the inventory inside the collapsed details disclosure", () => {
    expect(html.indexOf('id="env-progress-state"')).toBeGreaterThan(
      html.indexOf('id="env-progress-details"')
    );
    expect(html.indexOf('id="env-progress-state"')).toBeLessThan(
      html.indexOf("</details>")
    );
  });

  it("describes rollback-eligible resources in customer terms", () => {
    expect(html).toContain("Created by Radius and available to roll back");
    expect(html).not.toContain("Retained for a retry");
  });
});
