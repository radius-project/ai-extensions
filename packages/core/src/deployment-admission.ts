export interface DeploymentAdmissionTarget {
  readonly repo: string;
  readonly environment: string;
  readonly branch?: string;
  readonly savedLogin?: string;
}

export interface DeploymentAdmissionPorts<Executor, Reservation> {
  reserve(): Reservation | undefined;
  release(reservation: Reservation): void;
  isCurrent(reservation: Reservation): boolean;
  selectAccount(input: {
    target: { repo: string; environment: string };
    savedLogin?: string;
    isCurrent(): boolean;
  }): Promise<Executor>;
  readDeployment(executor: Executor): Promise<{ status: string } | null>;
  blocksMutation(status: string): boolean;
  readDefaultBranch(executor: Executor): Promise<string>;
}

export type DeploymentAdmission<Executor, Reservation> =
  | {
      kind: "admitted";
      executor: Executor;
      reservation: Reservation;
      branch: string;
    }
  | {
      kind: "refused";
      reason: "conflict" | "unavailable";
      message: string;
    };

export async function admitDeployment<Executor, Reservation>(
  input: DeploymentAdmissionTarget,
  ports: DeploymentAdmissionPorts<Executor, Reservation>
): Promise<DeploymentAdmission<Executor, Reservation>> {
  const { repo, environment, savedLogin } = input;
  let branch = input.branch ?? "";
  if (!repo.trim() || !environment.trim()) {
    throw new Error("targetRepo and environment are required.");
  }
  const reservation = ports.reserve();
  if (reservation === undefined) {
    return {
      kind: "refused",
      reason: "conflict",
      message: "Another deployment operation is already starting."
    };
  }
  let admitted = false;
  const isCurrent = () => ports.isCurrent(reservation);
  const assertCurrent = () => {
    if (!isCurrent())
      throw new Error("The deployment context changed during admission.");
  };
  try {
    assertCurrent();
    const executor = await ports.selectAccount({
      target: { repo, environment },
      savedLogin,
      isCurrent
    });
    assertCurrent();
    let current: { status: string } | null;
    try {
      current = await ports.readDeployment(executor);
    } catch {
      return {
        kind: "refused",
        reason: "unavailable",
        message:
          "Could not verify whether this environment already has an operation in progress. Check your GitHub connection and try again."
      };
    }
    assertCurrent();
    if (current && ports.blocksMutation(current.status)) {
      return {
        kind: "refused",
        reason: "conflict",
        message:
          current.status === "deleting" ?
            "This deployment is currently being deleted. Wait for it to finish before deploying again."
          : "A deployment to this environment is already in progress."
      };
    }
    if (!branch) {
      branch = (await ports.readDefaultBranch(executor)).trim();
      if (!branch) throw new Error("Could not resolve the deployment branch.");
    }
    assertCurrent();
    admitted = true;
    return { kind: "admitted", branch, executor, reservation };
  } finally {
    if (!admitted) ports.release(reservation);
  }
}
