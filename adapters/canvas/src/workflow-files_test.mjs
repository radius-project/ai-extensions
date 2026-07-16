import assert from "node:assert/strict";
import { test } from "vitest";
import {
    DELETE_WORKFLOW_FILES,
    DEPLOY_WORKFLOW_FILES,
    environmentWorkflowFileEntries,
} from "./workflow-files.mjs";

function workflowsFor(files) {
    return Object.fromEntries(files.map((fileName) => [fileName, `name: ${fileName}`]));
}

test("returns the complete six-file workflow set for an Azure environment", () => {
    const entries = environmentWorkflowFileEntries(
        workflowsFor(DEPLOY_WORKFLOW_FILES),
        workflowsFor(DELETE_WORKFLOW_FILES),
    );

    assert.deepEqual(
        [...entries.deploy, ...entries.delete].map(([fileName]) => fileName),
        [
            "run-rad-commands.yml",
            "run-rad-commands-azure.yml",
            "run-rad-commands-aws.yml",
            "delete-application.yml",
            "delete-azure.yml",
            "delete-aws.yml",
        ],
    );
});

test("rejects an incomplete provider workflow set before files are committed", () => {
    const deployWorkflows = workflowsFor(DEPLOY_WORKFLOW_FILES);
    delete deployWorkflows["run-rad-commands-aws.yml"];

    assert.throws(
        () => environmentWorkflowFileEntries(
            deployWorkflows,
            workflowsFor(DELETE_WORKFLOW_FILES),
        ),
        /missing required file "run-rad-commands-aws\.yml"/,
    );
});
