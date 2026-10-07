const MINUTE_MS = 60_000;

// The fixture's GitHub App installation token expires after one hour. A fresh
// token is minted before every serial stage and teardown, so each individual
// ceiling must fit inside that lifetime; the whole suite no longer has to.
export const CLOUD_INSTALLATION_TOKEN_LIFETIME_MS = 60 * MINUTE_MS;
export const CLOUD_MINIMUM_REFRESHED_TOKEN_LIFETIME_MS = 59 * MINUTE_MS;
export const CLOUD_HOOK_TEARDOWN_HEADROOM_MS = 25 * MINUTE_MS;

export const CREATE_OPERATION_TIMEOUT_MS = 20 * MINUTE_MS;
export const CREATE_TEST_TIMEOUT_MS =
  CREATE_OPERATION_TIMEOUT_MS + 10 * MINUTE_MS;

export const DELETE_OPERATION_TIMEOUT_MS = 31 * MINUTE_MS;
export const DELETE_POSTCONDITION_TIMEOUT_MS = 10 * MINUTE_MS;
// The environment row may take one window to appear before deletion and one
// window to disappear afterward; neither is concurrent with the operation poll.
export const DELETE_TEST_TIMEOUT_MS =
  DELETE_OPERATION_TIMEOUT_MS +
  2 * DELETE_POSTCONDITION_TIMEOUT_MS +
  4 * MINUTE_MS;

export const DEPLOYMENT_OPERATION_TIMEOUT_MS = 45 * MINUTE_MS;
export const DEPLOYMENT_TEST_TIMEOUT_MS =
  DEPLOYMENT_OPERATION_TIMEOUT_MS + 5 * MINUTE_MS;
export const DELETE_REFUSAL_TEST_TIMEOUT_MS = 10 * MINUTE_MS;

export const SERIAL_TEST_TIMEOUT_BUDGET_MS =
  CREATE_TEST_TIMEOUT_MS +
  DEPLOYMENT_TEST_TIMEOUT_MS +
  DELETE_REFUSAL_TEST_TIMEOUT_MS +
  DEPLOYMENT_TEST_TIMEOUT_MS +
  DELETE_TEST_TIMEOUT_MS;
export const CLOUD_SUITE_TIMEOUT_MS =
  SERIAL_TEST_TIMEOUT_BUDGET_MS + CLOUD_HOOK_TEARDOWN_HEADROOM_MS;

// The opt-in Copilot app host adds two stages before the harness stages: the
// worker fixture that installs the extension and starts the app, and the test
// that asks the Radius agent to model the clean fixture.
export const COPILOT_APP_SETUP_TIMEOUT_MS = 15 * MINUTE_MS;
export const MODEL_GENERATION_TIMEOUT_MS = 30 * MINUTE_MS;
export const MODELING_TEST_TIMEOUT_MS =
  MODEL_GENERATION_TIMEOUT_MS + 10 * MINUTE_MS;
export const COPILOT_APP_SERIAL_TEST_TIMEOUT_BUDGET_MS =
  COPILOT_APP_SETUP_TIMEOUT_MS +
  MODELING_TEST_TIMEOUT_MS +
  SERIAL_TEST_TIMEOUT_BUDGET_MS;
export const COPILOT_APP_SUITE_TIMEOUT_MS =
  COPILOT_APP_SERIAL_TEST_TIMEOUT_BUDGET_MS + CLOUD_HOOK_TEARDOWN_HEADROOM_MS;
