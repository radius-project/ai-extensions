import { describe, it, expect } from "vitest";
import { unlabelledSelectIds } from "../../../test/support/pages/labelled-controls.js";
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

  it("renders one visible section when the environments sub-tab is active", () => {
    const html = environmentsPaneMarkup(baseOptions);
    expect(html).toContain('<section id="pane-environments" style="">');
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
});
