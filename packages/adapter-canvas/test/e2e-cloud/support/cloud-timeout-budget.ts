const MINUTE_MS = 60_000;

// The fixture's GitHub App installation token expires after one hour. Keep the
// serial test ceilings inside that lifetime while reserving suite time for the
// provisioning and cleanup hooks, which run outside either test's timeout.
export const CLOUD_INSTALLATION_TOKEN_LIFETIME_MS = 60 * MINUTE_MS;
export const CLOUD_HOOK_TEARDOWN_HEADROOM_MS = 15 * MINUTE_MS;

export const CREATE_OPERATION_TIMEOUT_MS = 20 * MINUTE_MS;
export const CREATE_TEST_TIMEOUT_MS =
  CREATE_OPERATION_TIMEOUT_MS + 3 * MINUTE_MS;

export const DELETE_OPERATION_TIMEOUT_MS = 31 * MINUTE_MS;
export const DELETE_POSTCONDITION_TIMEOUT_MS = 10 * MINUTE_MS;
export const DELETE_TEST_TIMEOUT_MS =
  DELETE_OPERATION_TIMEOUT_MS + 5 * MINUTE_MS;

export const SERIAL_TEST_TIMEOUT_BUDGET_MS =
  CREATE_TEST_TIMEOUT_MS + DELETE_TEST_TIMEOUT_MS;
