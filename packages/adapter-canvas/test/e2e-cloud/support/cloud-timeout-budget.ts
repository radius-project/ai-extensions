const MINUTE_MS = 60_000;

// Each stage receives a freshly minted one-hour installation token. The suite
// budget separately reserves time for provisioning and cleanup hooks.
export const CLOUD_INSTALLATION_TOKEN_LIFETIME_MS = 60 * MINUTE_MS;
export const CLOUD_HOOK_TEARDOWN_HEADROOM_MS = 20 * MINUTE_MS;

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

export const SERIAL_TEST_TIMEOUT_BUDGET_MS =
  CREATE_TEST_TIMEOUT_MS + DELETE_TEST_TIMEOUT_MS;
