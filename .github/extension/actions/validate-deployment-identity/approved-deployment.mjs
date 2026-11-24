const idPattern = /^[1-9]\d*$/;

function runMatches(repo, url, run) {
  const prefix = `https://github.com/${repo}/actions/runs/${run}`.toLowerCase();
  return (
    typeof url === "string" &&
    url.toLowerCase().startsWith(prefix) &&
    /^(?:\/job\/[1-9]\d*)?\/?$/.test(url.slice(prefix.length))
  );
}

export async function verifyApprovedDeployment(env, read) {
  const {
    APPROVED_DEPLOYMENT_ID: deployment,
    APPROVED_RUN_ID: approvedRun,
    GITHUB_RUN_ID: currentRun,
    GITHUB_RUN_ATTEMPT: attempt,
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
    attempt !== "1" ||
    approvedRun === currentRun ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") ||
    !environment
  )
    fail();

  const base = `/repos/${repo}/deployments`;
  const history = `${base}?environment=${encodeURIComponent(environment)}&per_page=10`;
  async function orderedIds() {
    const rows = await read(history);
    if (!Array.isArray(rows) || !rows.length) fail();
    const ids = rows.map((row) => row?.id);
    const nodes = rows.map((row) => row?.node_id);
    if (
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length ||
      nodes.some((id) => typeof id !== "string" || !id) ||
      new Set(nodes).size !== nodes.length
    )
      fail();
    return ids.map((id, i) => ({ id: String(id), node: nodes[i] }));
  }
  const before = await orderedIds();
  if (before[1]?.id !== deployment) fail();
  const runPath = `/repos/${repo}/actions/runs/${currentRun}`;
  const run = await read(runPath);
  if (
    !Number.isSafeInteger(run?.id) ||
    String(run.id) !== currentRun ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/delete-application.yml" ||
    typeof run.repository?.full_name !== "string" ||
    run.repository.full_name.toLowerCase() !== repo.toLowerCase() ||
    typeof run.node_id !== "string" ||
    !run.node_id
  )
    fail();
  const jobs = await read(`${runPath}/attempts/${attempt}/jobs?per_page=30`);
  if (
    !Array.isArray(jobs?.jobs) ||
    jobs.jobs.length === 0 ||
    jobs.total_count !== jobs.jobs.length ||
    jobs.jobs.length > 30
  )
    fail();
  const ids = jobs.jobs.map((job) => job?.node_id);
  if (
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  )
    fail();
  // GitHub populates this relation; writers can set a status URL, but it
  // cannot create a corresponding deployment relationship on an Actions job.
  const links = await read("/graphql", {
    query: `query($ids: [ID!]!) { nodes(ids: $ids) {
      ... on CheckRun {
        id
        checkSuite { workflowRun { id } }
        deployment { id environment }
      }
    } }`,
    variables: { ids }
  });
  const nodes = links?.data?.nodes;
  if (
    links?.errors ||
    !Array.isArray(nodes) ||
    nodes.length !== ids.length ||
    nodes.some(
      (node, i) =>
        node?.id !== ids[i] || node.checkSuite?.workflowRun?.id !== run.node_id
    )
  )
    fail();
  const linked = nodes.filter((node) => node.deployment !== null);
  const providerDeployment = linked.length === 1 ? linked[0].deployment : null;
  if (
    typeof providerDeployment?.environment !== "string" ||
    providerDeployment.environment.toLowerCase() !==
      environment.toLowerCase() ||
    providerDeployment.id !== before[0].node
  )
    fail();
  const statuses = await read(`${base}/${deployment}/statuses?per_page=1`);
  const status = Array.isArray(statuses) && statuses[0];
  if (
    !status ||
    !runMatches(repo, status.log_url || status.target_url, approvedRun) ||
    !["success", "failure", "error"].includes(status.state)
  )
    fail();
  const after = await orderedIds();
  if (
    after.length !== before.length ||
    after.some(
      ({ id, node }, i) => id !== before[i].id || node !== before[i].node
    )
  )
    fail();
}
