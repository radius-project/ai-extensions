import {
    DEPLOY_DISPATCHER_FILE,
    DEPLOY_AZURE_FILE,
    DEPLOY_AWS_FILE,
    DELETE_APP_DISPATCHER_FILE,
    DELETE_AZURE_FILE,
    DELETE_AWS_FILE,
} from "@radius-project/core";

export const DEPLOY_WORKFLOW_FILES = Object.freeze([
    DEPLOY_DISPATCHER_FILE,
    DEPLOY_AZURE_FILE,
    DEPLOY_AWS_FILE,
]);

export const DELETE_WORKFLOW_FILES = Object.freeze([
    DELETE_APP_DISPATCHER_FILE,
    DELETE_AZURE_FILE,
    DELETE_AWS_FILE,
]);

function requiredWorkflowEntries(workflows, requiredFiles, workflowKind) {
    if (!workflows || typeof workflows !== "object") {
        throw new Error(`Failed to generate the required ${workflowKind} workflows.`);
    }

    return requiredFiles.map((fileName) => {
        const content = workflows[fileName];
        if (typeof content !== "string" || !content.trim()) {
            throw new Error(`Generated ${workflowKind} workflows are missing required file "${fileName}".`);
        }
        return [fileName, content];
    });
}

export function deployWorkflowFileEntries(workflows) {
    return requiredWorkflowEntries(workflows, DEPLOY_WORKFLOW_FILES, "deploy");
}

export function deleteWorkflowFileEntries(workflows) {
    return requiredWorkflowEntries(workflows, DELETE_WORKFLOW_FILES, "delete");
}

export function environmentWorkflowFileEntries(deployWorkflows, deleteWorkflows) {
    return {
        deploy: deployWorkflowFileEntries(deployWorkflows),
        delete: deleteWorkflowFileEntries(deleteWorkflows),
    };
}
