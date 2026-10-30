// Canvas adapter: browser behavior for the AWS half of the environment
// wizard's Infrastructure section. The VPC follows the selected EKS cluster,
// and Subnets is a checklist limited to that VPC that states each subnet's
// availability zone and whether it is public. A selection must span two zones.

import {
  AWS_MINIMUM_SUBNET_ZONES,
  awsSubnetZones,
  defaultAwsSubnetSelection,
  type AwsSubnet
} from "@radius-project/core/platforms";
import { isRecord, readString } from "../json.js";
import type { EntryScope } from "../lifecycle.js";
import type { BrowserContext, DomInputElement } from "../ports.js";

export const AWS_SUBNETS_LIST_ID = "aws-subnets-list";
export const AWS_SUBNETS_ERROR_ID = "aws-subnets-error";
export const AWS_SUBNETS_NOTE_ID = "aws-subnets-note";
export const AWS_INFRA_WARNING_ID = "aws-infra-warning";

export const AWS_SUBNET_ZONES_ERROR =
  "Select subnets in at least two availability zones.";
export const AWS_SUBNET_NOTE =
  "Two availability zones are required. Public subnets are reachable from the internet.";
export const AWS_NO_PRIVATE_ZONES_NOTE =
  "The cluster's private subnets do not span two availability zones, so none were selected. Choose subnets in at least two zones.";
export const AWS_OTHER_VPC_WARNING =
  "This is not the cluster's VPC. Reaching it from the cluster needs VPC peering or a transit gateway, which Radius does not create.";
export const AWS_PUBLIC_SUBNET_WARNING =
  "A public subnet is selected. Anything provisioned there is reachable from the internet.";

export interface AwsClusterInfo {
  readonly id: string;
  readonly vpcId: string;
  readonly authenticationMode: string;
  readonly usable: boolean;
}

export type AwsSubnetInfo = Readonly<AwsSubnet>;

export function parseAwsClusterInfo(
  items: readonly unknown[]
): AwsClusterInfo[] {
  return items.filter(isRecord).flatMap((item) => {
    const id = readString(item, "id");
    if (id === "") return [];
    return [
      {
        id,
        vpcId: readString(item, "vpcId"),
        authenticationMode: readString(item, "authenticationMode"),
        usable: item.usable !== false
      }
    ];
  });
}

export function parseAwsSubnetInfo(items: readonly unknown[]): AwsSubnetInfo[] {
  return items.filter(isRecord).flatMap((item) => {
    const id = readString(item, "id");
    if (id === "") return [];
    return [
      {
        id,
        name: readString(item, "name"),
        vpcId: readString(item, "vpcId"),
        availabilityZone: readString(item, "availabilityZone"),
        public: item.public === true
      }
    ];
  });
}

export function awsSubnetSelectionError(
  subnets: readonly AwsSubnetInfo[],
  selected: readonly string[]
): string {
  return awsSubnetZones(subnets, selected).length >= AWS_MINIMUM_SUBNET_ZONES ?
      ""
    : AWS_SUBNET_ZONES_ERROR;
}

export function awsInfrastructureWarnings(input: {
  readonly subnets: readonly AwsSubnetInfo[];
  readonly selected: readonly string[];
  readonly vpcId: string;
  readonly clusterVpcId: string;
}): string[] {
  const warnings: string[] = [];
  if (
    input.vpcId !== "" &&
    input.clusterVpcId !== "" &&
    input.vpcId !== input.clusterVpcId
  ) {
    warnings.push(AWS_OTHER_VPC_WARNING);
  }
  if (
    input.subnets.some(
      (subnet) => subnet.public && input.selected.includes(subnet.id)
    )
  ) {
    warnings.push(AWS_PUBLIC_SUBNET_WARNING);
  }
  return warnings;
}

export interface AwsInfrastructureHandle {
  /** Apply a fresh discovery: follow the cluster's VPC and default subnets. */
  setDiscovered(
    clusters: readonly AwsClusterInfo[],
    subnets: readonly AwsSubnetInfo[]
  ): void;
  /** Restore a saved selection, such as when editing an environment. */
  restore(vpcId: string, subnetIds: readonly string[]): void;
  /** Forget the last discovery, so nothing from an old account or region is kept. */
  reset(): void;
  selectedSubnetIds(): string[];
  validationError(): string;
}

export function initializeAwsInfrastructure(
  context: BrowserContext,
  scope: EntryScope,
  onChange: () => void
): AwsInfrastructureHandle {
  let clusters: readonly AwsClusterInfo[] = [];
  let subnets: readonly AwsSubnetInfo[] = [];
  let selected: string[] = [];
  let noPrivateZones = false;
  let discovered = false;

  const clusterSelect = (): DomInputElement | null =>
    context.dom.selectById("aws-cluster-select");
  const vpcSelect = (): DomInputElement | null =>
    context.dom.selectById("aws-vpc-select");
  const clusterVpcId = (): string => {
    const id = clusterSelect()?.value ?? "";
    return clusters.find((cluster) => cluster.id === id)?.vpcId ?? "";
  };
  const currentVpcId = (): string => vpcSelect()?.value ?? "";

  const renderMessages = (): void => {
    const error = context.dom.byId(AWS_SUBNETS_ERROR_ID);
    const note = context.dom.byId(AWS_SUBNETS_NOTE_ID);
    const warning = context.dom.byId(AWS_INFRA_WARNING_ID);
    const message =
      discovered ? awsSubnetSelectionError(subnets, selected) : "";
    if (error) {
      error.textContent = message;
      error.hidden = message === "";
    }
    context.dom
      .byId(AWS_SUBNETS_LIST_ID)
      ?.setAttribute("aria-invalid", message === "" ? "false" : "true");
    if (note) {
      note.textContent =
        noPrivateZones ? AWS_NO_PRIVATE_ZONES_NOTE : AWS_SUBNET_NOTE;
    }
    const warnings = awsInfrastructureWarnings({
      subnets,
      selected,
      vpcId: currentVpcId(),
      clusterVpcId: clusterVpcId()
    });
    if (warning) {
      warning.textContent = warnings.join(" ");
      warning.hidden = warnings.length === 0;
    }
    onChange();
  };

  const renderSubnets = (): void => {
    const list = context.dom.byId(AWS_SUBNETS_LIST_ID);
    if (!list) return;
    list.replaceChildren();
    const vpcId = currentVpcId();
    const inVpc = subnets.filter((subnet) => subnet.vpcId === vpcId);
    if (inVpc.length === 0) {
      const empty = context.dom.createElement("div");
      empty.className = "rad-subnet-list__empty";
      empty.setAttribute(
        "style",
        "padding:4px 10px; font-size:13px; color:var(--rad-text-tertiary);"
      );
      empty.textContent =
        vpcId === "" ?
          "Select a VPC to list its subnets."
        : "This VPC has no subnets.";
      list.appendChild(empty);
    }
    for (const subnet of inVpc) {
      const row = context.dom.createElement("label");
      row.className = "rad-subnet-list__row";
      row.setAttribute(
        "style",
        "display:grid; grid-template-columns:auto 1fr auto auto; gap:16px; align-items:center; padding:4px 10px; font-size:13px; cursor:pointer;"
      );
      const box = context.dom.createElement("input");
      box.setAttribute("type", "checkbox");
      box.setAttribute("value", subnet.id);
      box.id = `aws-subnet-${subnet.id}`;
      if (selected.includes(subnet.id)) box.setAttribute("checked", "checked");
      scope.on(box, "change", () => {
        const checked = Reflect.get(box, "checked") === true;
        selected =
          checked ?
            [...selected.filter((id) => id !== subnet.id), subnet.id]
          : selected.filter((id) => id !== subnet.id);
        noPrivateZones = false;
        renderMessages();
      });
      const id = context.dom.createElement("span");
      id.className = "rad-subnet-list__id";
      id.textContent =
        subnet.name ? `${subnet.id} (${subnet.name})` : subnet.id;
      const zone = context.dom.createElement("span");
      zone.className = "rad-subnet-list__zone";
      zone.textContent = subnet.availabilityZone;
      const kind = context.dom.createElement("span");
      kind.className = "rad-subnet-list__kind";
      kind.textContent = subnet.public ? "public" : "private";
      row.appendChild(box);
      row.appendChild(id);
      row.appendChild(zone);
      row.appendChild(kind);
      list.appendChild(row);
    }
    renderMessages();
  };

  const applyVpcDefaults = (): void => {
    selected = defaultAwsSubnetSelection(subnets, currentVpcId());
    noPrivateZones =
      selected.length === 0 &&
      subnets.some(
        (subnet) => subnet.vpcId === currentVpcId() && !subnet.public
      );
    renderSubnets();
  };

  const followClusterVpc = (): void => {
    const vpc = vpcSelect();
    const target = clusterVpcId();
    if (vpc && target !== "") vpc.value = target;
    applyVpcDefaults();
  };

  const cluster = clusterSelect();
  if (cluster) scope.on(cluster, "change", followClusterVpc);
  const vpc = vpcSelect();
  if (vpc) scope.on(vpc, "change", applyVpcDefaults);

  return {
    setDiscovered(nextClusters, nextSubnets) {
      clusters = nextClusters;
      subnets = nextSubnets;
      discovered = true;
      followClusterVpc();
    },
    restore(vpcId, subnetIds) {
      const select = vpcSelect();
      if (select && vpcId !== "") select.value = vpcId;
      selected = [...subnetIds];
      noPrivateZones = false;
      renderSubnets();
    },
    reset() {
      clusters = [];
      subnets = [];
      selected = [];
      noPrivateZones = false;
      discovered = false;
      renderSubnets();
    },
    selectedSubnetIds: () => [...selected],
    validationError: () =>
      discovered ?
        awsSubnetSelectionError(subnets, selected)
      : AWS_SUBNET_ZONES_ERROR
  };
}
