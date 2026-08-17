import { describe, it, expect } from "vitest";
import {
  DELETE_DEPLOYMENT_DIALOG_HTML,
  GRAPH_DIFF_SUBTITLE
} from "./fragments.js";

describe("DELETE_DEPLOYMENT_DIALOG_HTML", () => {
  it("declares one modal dialog with the labelled title the client drives", () => {
    expect(DELETE_DEPLOYMENT_DIALOG_HTML).toContain('id="deploy-delete-modal"');
    expect(DELETE_DEPLOYMENT_DIALOG_HTML).toContain(
      '<div class="rad-ddlg" role="dialog" aria-modal="true" aria-labelledby="deploy-delete-title">'
    );
    for (const id of [
      "deploy-delete-title",
      "deploy-delete-close",
      "deploy-delete-app",
      "deploy-delete-env",
      "deploy-delete-body"
    ]) {
      expect(DELETE_DEPLOYMENT_DIALOG_HTML).toContain(`id="${id}"`);
    }
  });

  it("ships no confirmation copy of its own so every page shares one flow", () => {
    // The three-step type-to-confirm body is filled in by
    // radiusCreateDeleteDeploymentDialog, so the fragment must stay empty.
    expect(DELETE_DEPLOYMENT_DIALOG_HTML).toContain(
      '<div class="rad-ddlg__content" id="deploy-delete-body"></div>'
    );
    expect(DELETE_DEPLOYMENT_DIALOG_HTML).not.toContain(
      "Are you sure you want to delete"
    );
    expect(DELETE_DEPLOYMENT_DIALOG_HTML).toContain('aria-label="Close"');
  });

  it("is inert markup with no interpolation left behind", () => {
    expect(DELETE_DEPLOYMENT_DIALOG_HTML).not.toContain("${");
    expect(DELETE_DEPLOYMENT_DIALOG_HTML.startsWith("<div")).toBe(true);
    expect(DELETE_DEPLOYMENT_DIALOG_HTML.endsWith("</div>")).toBe(true);
  });
});

describe("GRAPH_DIFF_SUBTITLE", () => {
  it("carries the stable subtitle id and the diff explanation", () => {
    expect(GRAPH_DIFF_SUBTITLE).toContain('id="graph-diff-subtitle"');
    expect(GRAPH_DIFF_SUBTITLE).toContain(
      "The application graph diff compares the application model between branches"
    );
    expect(GRAPH_DIFF_SUBTITLE).toContain("added, removed, or modified");
    expect(GRAPH_DIFF_SUBTITLE).not.toContain("${");
  });
});
