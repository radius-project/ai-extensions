import { boundedDiagnostic, CommandFailure } from "../../command-failure.js";
import type { DiscoveryDependencies } from "./discovery.js";

export interface DiscoveryCommandEvent {
  step: string;
  startedAt: string;
  durationMs: number;
  timeoutMs: number;
  exitCode: string | number | null;
  signal: string | null;
  timedOut: boolean;
  error?: string;
}

const STEPS = new Set([
  "az account set",
  "az aks list",
  "az group list",
  "az aks get-credentials",
  "aws eks list-clusters",
  "aws eks describe-cluster",
  "aws eks update-kubeconfig",
  "aws ec2 describe-vpcs",
  "aws ec2 describe-subnets",
  "aws ec2 describe-route-tables",
  "aws ec2 describe-availability-zones"
]);

export function observeDiscoveryCommands(
  runCli: DiscoveryDependencies["runCli"],
  events: DiscoveryCommandEvent[],
  now: () => number
): DiscoveryDependencies["runCli"] {
  return async (command, args, options) => {
    const candidate = [command, ...args.slice(0, 2)].join(" ");
    const started = now();
    const event: DiscoveryCommandEvent = {
      step:
        command === "kubectl" ? "kubectl get namespaces"
        : STEPS.has(candidate) ? candidate
        : "discovery command",
      startedAt: new Date(started).toISOString(),
      durationMs: 0,
      timeoutMs: options.timeout,
      exitCode: null,
      signal: null,
      timedOut: false
    };
    try {
      const output = await runCli(command, args, options);
      event.exitCode = 0;
      return output;
    } catch (error) {
      if (error instanceof CommandFailure) {
        event.exitCode = error.code;
        event.signal = error.signal;
        event.timedOut = error.timedOut;
      }
      event.error = boundedDiagnostic(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    } finally {
      event.durationMs = Math.max(0, now() - started);
      events.push(event);
    }
  };
}
