const idPattern = /^[1-9]\d*$/;

function runMatches(repo, url, run) {
  const prefix = `https://github.com/${repo}/actions/runs/${run}`.toLowerCase();
  return (
    typeof url === "string" &&
    url.toLowerCase().startsWith(prefix) &&
    /^(?:\/job\/[1-9]\d*)?\/?$/.test(url.slice(prefix.length))
  );
}

// Run inside the provider's existing deploy/delete concurrency group. Actions
// creates deployment records for this delete's own environment-bound jobs.
// A workflow name does not establish that it did not modify Radius state.
// Skip only records positively linked to this delete run.
export async function verifyApprovedDeployment(env, read) {
  const {
    APPROVED_DEPLOYMENT_ID: deployment,
    APPROVED_RUN_ID: approvedRun,
    GITHUB_RUN_ID: currentRun,
    GITHUB_REPOSITORY: repo,
    TARGET_ENVIRONMENT: environment
  } = env;
  if (!deployment && !approvedRun) return;
  const fail = () => {
    throw new Error(
      "The approved deployment could not be verified as current. Refresh the Radius listing and confirm again. No cloud work was started."
    );
  };
  if (
    !idPattern.test(deployment ?? "") ||
    !idPattern.test(approvedRun ?? "") ||
    !idPattern.test(currentRun ?? "") ||
    approvedRun === currentRun ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") ||
    !environment
  )
    fail();

  const base = `/repos/${repo}/deployments`;
  const rows = await read(
    `${base}?environment=${encodeURIComponent(environment)}&per_page=10`
  );
  if (!Array.isArray(rows)) fail();
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.id) || row.id <= 0) fail();
    const statuses = await read(`${base}/${row.id}/statuses?per_page=1`);
    if (!Array.isArray(statuses) || !statuses[0]) fail();
    const status = statuses[0];
    const url = status.log_url || status.target_url;
    if (runMatches(repo, url, currentRun)) continue;
    if (
      String(row.id) !== deployment ||
      !runMatches(repo, url, approvedRun) ||
      !["success", "failure", "error"].includes(status.state)
    )
      fail();
    return;
  }
  fail();
}
