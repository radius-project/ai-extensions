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
    expect(html).toContain(
      'id="env-gh-fix-access" class="rad-btn rad-btn--ghost"'
    );
    expect(html).toContain(">Show how to fix</button>");
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
  });

  it("associates the environment label with its input", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain(
      '<label for="env-name-input">Environment name</label>'
    );
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
