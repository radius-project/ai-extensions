// Stable element ids shared by server-rendered page state and the generated
// browser entries that consume it. Keeping these behavior-free contracts under
// pages prevents executable browser modules from entering the Node artifact.

export const DEPLOY_RESULT_STATE_ID = "radius-deploy-result-state";
export const DEPLOYING_PAGE_STATE_ID = "radius-deploying-state";
export const ENVIRONMENT_PAGE_STATE_ID = "radius-environment-state";
