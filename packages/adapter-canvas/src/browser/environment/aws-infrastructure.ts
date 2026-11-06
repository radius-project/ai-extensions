// Canvas adapter: browser behavior for the AWS half of the environment
// wizard's Infrastructure section. The VPC is the selected EKS cluster's VPC,
// shown as text. Subnets is a checklist of that VPC's subnets that states each
// subnet's availability zone and routing. Only subnets in standard zones can be
// checked, and a selection must span two zones.

import {
  AWS_MINIMUM_SUBNET_ZONES,
  awsSubnetZones,
  defaultAwsSubnetSelection,
  enableAccessEntriesCommand,
  type AwsCliErrorKind,
  type AwsClusterUnusableReason,
  type AwsSubnet,
  type AwsSubnetRouting,
  type AwsVpc,
  type AwsZoneKind
} from "@radius-project/core/platforms";
import { isRecord, readString } from "../json.js";
import type { EntryScope } from "../lifecycle.js";
import type { BrowserContext } from "../ports.js";

export const AWS_CLUSTER_SELECT_ID = "aws-cluster-select";
export const AWS_VPC_VALUE_ID = "aws-vpc-value";
export const AWS_VPC_NOTE_ID = "aws-vpc-note";
export const AWS_NAMESPACE_NOTE_ID = "aws-namespace-note";
export const AWS_RESTORE_NOTE_ID = "aws-restore-note";
export const AWS_SUBNETS_LIST_ID = "aws-subnets-list";
export const AWS_SUBNETS_ERROR_ID = "aws-subnets-error";
export const AWS_SUBNETS_NOTE_ID = "aws-subnets-note";
export const AWS_INFRA_WARNING_ID = "aws-infra-warning";

export const AWS_CLUSTER_REQUIRED_ERROR = "Select an EKS cluster.";
export const AWS_SUBNETS_UNAVAILABLE_ERROR = "Subnets couldn't be listed.";
export const AWS_UNUSABLE_SUBNET_ERROR =
  "Select only subnets in standard availability zones of the cluster's VPC.";
export const AWS_SUBNET_ZONES_ERROR =
  "Select subnets in at least two availability zones.";
export const AWS_SUBNET_NOTE =
  "Two availability zones are required. Local Zone, Wavelength Zone, and Outpost subnets can't be selected.";
export const AWS_NO_PRIVATE_ZONES_NOTE =
  "The cluster's VPC doesn't have private subnets in two availability zones, so no subnets are selected. Select subnets in at least two zones.";
export const AWS_PUBLIC_SUBNET_WARNING =
  "A public subnet is selected. Its route table has a route to an internet gateway. A resource in this subnet can be reached from the internet only if it gets a public IP address and its security groups and network ACLs allow the traffic.";
export const AWS_ROUTING_DENIED_WARNING =
  "Public and private subnets can't be told apart, because the signed-in identity can't read route tables (ec2:DescribeRouteTables). Select the subnets yourself.";
export const AWS_ROUTING_UNREAD_WARNING =
  "Route tables couldn't be read, so public and private subnets can't be told apart. Select the subnets yourself.";
export const AWS_VPC_DENIED_NOTE =
  "Only the VPC ID is shown, because the signed-in identity can't read VPCs (ec2:DescribeVpcs).";
export const AWS_VPC_UNREAD_NOTE =
  "Only the VPC ID is shown, because VPCs couldn't be read.";
export const AWS_NO_CLUSTER_VPC_TEXT = "Select a cluster to see its VPC.";
export const AWS_NO_CLUSTER_SUBNETS_TEXT =
  "Select a cluster to list its subnets.";
export const AWS_NO_SUBNETS_TEXT = "The cluster's VPC has no subnets.";
export const AWS_SUBNETS_UNAVAILABLE_TEXT = "Subnets unavailable.";
export const AWS_NOT_IN_VPC_REASON = "not found in the cluster's VPC";

export interface AwsClusterInfo {
  readonly id: string;
  readonly name: string;
  readonly vpcId: string;
  readonly authenticationMode: string;
  readonly status: string;
  readonly usable: boolean;
  /** Empty for a usable cluster. */
  readonly unusableReason: AwsClusterUnusableReason | "";
  /** The error kind of a failed describe-cluster call, or empty. */
  readonly describeErrorKind: AwsCliErrorKind | "";
}

export type AwsSubnetInfo = Readonly<AwsSubnet>;

export type AwsVpcInfo = Readonly<AwsVpc>;

/** One line of the cluster note, with an optional command shown as code. */
export interface AwsClusterNoteLine {
  readonly text: string;
  readonly command?: string;
}

const UNUSABLE_REASONS: readonly AwsClusterUnusableReason[] = [
  "not-described",
  "status",
  "config-map"
];
const ERROR_KINDS: readonly AwsCliErrorKind[] = [
  "denied",
  "credentials",
  "rejected",
  "other"
];
const ROUTINGS: readonly AwsSubnetRouting[] = ["public", "private"];
const ZONE_KINDS: readonly AwsZoneKind[] = [
  "standard",
  "local-zone",
  "wavelength-zone",
  "outpost"
];
const ZONE_LABELS: Readonly<Record<AwsZoneKind, string>> = {
  standard: "",
  "local-zone": "Local Zone",
  "wavelength-zone": "Wavelength Zone",
  outpost: "Outpost"
};

function isOneOf<T extends string>(
  allowed: readonly T[],
  value: string
): value is T {
  return allowed.some((item) => item === value);
}

/**
 * An AWS CLI error kind from a discovery response: empty for no error, and
 * "other" for a kind this build does not know.
 */
export function readAwsCliErrorKind(value: string): AwsCliErrorKind | "" {
  if (value === "") return "";
  return isOneOf(ERROR_KINDS, value) ? value : "other";
}

/** The error kind of each discovery list that failed. */
export function readAwsErrorKinds(
  value: unknown
): Partial<Record<string, AwsCliErrorKind>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([list, kind]) =>
      typeof kind === "string" ?
        [[list, readAwsCliErrorKind(kind) || "other"]]
      : []
    )
  );
}

export function parseAwsClusterInfo(
  items: readonly unknown[]
): AwsClusterInfo[] {
  return items.filter(isRecord).flatMap((item) => {
    const id = readString(item, "id");
    if (id === "") return [];
    const usable = item.usable === true;
    const reason = readString(item, "unusableReason");
    return [
      {
        id,
        name: readString(item, "name") || id,
        vpcId: readString(item, "vpcId"),
        authenticationMode: readString(item, "authenticationMode"),
        status: readString(item, "status"),
        usable,
        unusableReason:
          usable ? ""
          : isOneOf(UNUSABLE_REASONS, reason) ? reason
          : "not-described",
        describeErrorKind: readAwsCliErrorKind(
          readString(item, "describeErrorKind")
        )
      }
    ];
  });
}

export function parseAwsSubnetInfo(items: readonly unknown[]): AwsSubnetInfo[] {
  return items.filter(isRecord).flatMap((item) => {
    const id = readString(item, "id");
    const routing = readString(item, "routing");
    const zoneKind = readString(item, "zoneKind");
    if (id === "" || !isOneOf(ZONE_KINDS, zoneKind)) return [];
    return [
      {
        id,
        name: readString(item, "name"),
        vpcId: readString(item, "vpcId"),
        availabilityZone: readString(item, "availabilityZone"),
        routing: isOneOf(ROUTINGS, routing) ? routing : "unknown",
        zoneKind
      }
    ];
  });
}

export function parseAwsVpcInfo(items: readonly unknown[]): AwsVpcInfo[] {
  return items.filter(isRecord).flatMap((item) => {
    const id = readString(item, "id");
    return id === "" ? [] : [{ id, name: readString(item, "name") }];
  });
}

/** How the form shows one cluster. */
export interface AwsClusterPresentation {
  /** The cluster select's option label, with the reason it can't be used. */
  readonly label: string;
  /** Why the cluster can't be used, or null for a usable cluster. */
  readonly note: AwsClusterNoteLine | null;
}

function notDescribedNoteLine(cluster: AwsClusterInfo): AwsClusterNoteLine {
  const name = cluster.name;
  switch (cluster.describeErrorKind) {
    case "denied":
      return {
        text: `The signed-in identity can't read ${name} (eks:DescribeCluster).`
      };
    case "credentials":
      return {
        text: `The AWS CLI session ended before ${name} could be read. Sign in, then select Refresh.`
      };
    case "rejected":
    case "other":
    case "":
      return {
        text: `AWS didn't return the details of ${name}. Select Refresh to try again.`
      };
  }
}

export function awsClusterPresentation(
  cluster: AwsClusterInfo,
  region: string
): AwsClusterPresentation {
  const name = cluster.name;
  switch (cluster.unusableReason) {
    case "":
      return { label: name, note: null };
    case "config-map":
      return {
        label: `${name} (CONFIG_MAP authentication)`,
        note: {
          text: `${name} uses CONFIG_MAP authentication, which doesn't support access entries. A cluster administrator can enable access entries with this command. After that, AWS doesn't allow a switch back to CONFIG_MAP.`,
          command: enableAccessEntriesCommand(cluster.id, region)
        }
      };
    case "status":
      return {
        label: `${name} (${cluster.status})`,
        note: {
          text: `${name} is ${cluster.status}. Radius can use a cluster that is ACTIVE or UPDATING.`
        }
      };
    case "not-described":
      return {
        label: `${name} (details unavailable)`,
        note: notDescribedNoteLine(cluster)
      };
  }
}

/**
 * The note under Namespace when the namespaces of a cluster couldn't be listed
 * and the list shows only default instead.
 */
export function awsNamespaceFallbackNote(cluster: string): string {
  return `Can't list the namespaces in ${cluster}. Use default, or enter a custom namespace. Deploy creates the namespace if the cluster doesn't have it.`;
}

export function awsMissingClusterNoteLine(
  cluster: string,
  region: string
): AwsClusterNoteLine {
  return { text: `The saved cluster ${cluster} wasn't found in ${region}.` };
}

/** True for a subnet the form lets the developer check. */
function isUsableSubnet(subnet: AwsSubnetInfo, vpcId: string): boolean {
  return subnet.vpcId === vpcId && subnet.zoneKind === "standard";
}

export function awsSubnetSelectionError(
  subnets: readonly AwsSubnetInfo[],
  vpcId: string,
  selected: readonly string[]
): string {
  const usable = new Set(
    subnets
      .filter((subnet) => isUsableSubnet(subnet, vpcId))
      .map((subnet) => subnet.id)
  );
  if (selected.some((id) => !usable.has(id))) return AWS_UNUSABLE_SUBNET_ERROR;
  return awsSubnetZones(subnets, selected).length >= AWS_MINIMUM_SUBNET_ZONES ?
      ""
    : AWS_SUBNET_ZONES_ERROR;
}

/**
 * The routing warning for a VPC whose route tables couldn't be read, or the
 * public-subnet warning when a public subnet is checked.
 */
export function awsInfrastructureWarnings(input: {
  readonly subnets: readonly AwsSubnetInfo[];
  readonly selected: readonly string[];
  readonly routeTablesErrorKind: AwsCliErrorKind | "";
}): string[] {
  if (input.subnets.length > 0 && input.routeTablesErrorKind !== "") {
    return [
      input.routeTablesErrorKind === "denied" ?
        AWS_ROUTING_DENIED_WARNING
      : AWS_ROUTING_UNREAD_WARNING
    ];
  }
  return (
      input.subnets.some(
        (subnet) =>
          subnet.routing === "public" && input.selected.includes(subnet.id)
      )
    ) ?
      [AWS_PUBLIC_SUBNET_WARNING]
    : [];
}

export interface AwsDiscovered {
  readonly clusters: readonly AwsClusterInfo[];
  readonly subnets: readonly AwsSubnetInfo[];
  readonly vpcs: readonly AwsVpcInfo[];
  /** The error kind of a failed subnet list, or empty. */
  readonly subnetsErrorKind: AwsCliErrorKind | "";
  /** The error kind of a failed route-table read, or empty. */
  readonly routeTablesErrorKind: AwsCliErrorKind | "";
  /** The error kind of a failed VPC read, or empty. */
  readonly vpcsErrorKind: AwsCliErrorKind | "";
}

export interface AwsInfrastructureHandle {
  /** Store a discovery result. Selects nothing; `showCluster` does that. */
  setDiscovered(discovered: AwsDiscovered): void;
  /**
   * Show one cluster: select it, show its VPC, and list its VPC's subnets.
   * `"defaults"` checks the default subnets. A list of saved subnet IDs checks
   * the usable ones and names each removed one in the restore note. An empty
   * or unusable cluster ID shows no cluster.
   */
  showCluster(clusterId: string, subnets: "defaults" | readonly string[]): void;
  /** Forget the last discovery, so nothing from an old account or region is kept. */
  reset(): void;
  /** The shown cluster's VPC, or empty when no cluster is shown. */
  vpcId(): string;
  selectedSubnetIds(): string[];
  validationError(): string;
}

const EMPTY_DISCOVERY: AwsDiscovered = {
  clusters: [],
  subnets: [],
  vpcs: [],
  subnetsErrorKind: "",
  routeTablesErrorKind: "",
  vpcsErrorKind: ""
};

export function initializeAwsInfrastructure(
  context: BrowserContext,
  scope: EntryScope,
  onChange: () => void
): AwsInfrastructureHandle {
  let discovered = EMPTY_DISCOVERY;
  let cluster: AwsClusterInfo | null = null;
  let selected: string[] = [];
  let removed: { readonly id: string; readonly reason: string }[] = [];
  let noPrivateZones = false;

  const clusterVpcId = (): string => cluster?.vpcId ?? "";
  const subnetsFailed = (): boolean => discovered.subnetsErrorKind !== "";
  const vpcSubnets = (): AwsSubnetInfo[] =>
    cluster === null || subnetsFailed() ?
      []
    : discovered.subnets.filter((subnet) => subnet.vpcId === clusterVpcId());

  const validationError = (): string => {
    if (cluster === null) return AWS_CLUSTER_REQUIRED_ERROR;
    if (subnetsFailed()) return AWS_SUBNETS_UNAVAILABLE_ERROR;
    return awsSubnetSelectionError(
      discovered.subnets,
      clusterVpcId(),
      selected
    );
  };

  const renderVpc = (): void => {
    const output = context.dom.byId(AWS_VPC_VALUE_ID);
    const note = context.dom.byId(AWS_VPC_NOTE_ID);
    const vpcId = clusterVpcId();
    const label = discovered.vpcs.find((vpc) => vpc.id === vpcId)?.name;
    if (output) {
      output.textContent =
        cluster === null ? AWS_NO_CLUSTER_VPC_TEXT : label || vpcId;
    }
    const noteText =
      cluster === null || discovered.vpcsErrorKind === "" ? ""
      : discovered.vpcsErrorKind === "denied" ? AWS_VPC_DENIED_NOTE
      : AWS_VPC_UNREAD_NOTE;
    if (note) {
      note.textContent = noteText;
      note.hidden = noteText === "";
    }
  };

  const renderMessages = (): void => {
    const error = context.dom.byId(AWS_SUBNETS_ERROR_ID);
    const note = context.dom.byId(AWS_SUBNETS_NOTE_ID);
    const restoreNote = context.dom.byId(AWS_RESTORE_NOTE_ID);
    const warning = context.dom.byId(AWS_INFRA_WARNING_ID);
    // The cluster and subnet-list errors have their own text in the list, so
    // only a selection problem shows under it.
    const message =
      cluster === null || subnetsFailed() ? "" : validationError();
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
    if (restoreNote) {
      restoreNote.textContent =
        removed.length === 0 ?
          ""
        : `These saved subnets were removed from the selection: ${removed
            .map((entry) => `${entry.id} (${entry.reason})`)
            .join(", ")}.`;
      restoreNote.hidden = removed.length === 0;
    }
    const warnings = awsInfrastructureWarnings({
      subnets: vpcSubnets(),
      selected,
      routeTablesErrorKind: discovered.routeTablesErrorKind
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
    const subnets = vpcSubnets();
    const emptyText =
      cluster === null ? AWS_NO_CLUSTER_SUBNETS_TEXT
      : subnetsFailed() ? AWS_SUBNETS_UNAVAILABLE_TEXT
      : subnets.length === 0 ? AWS_NO_SUBNETS_TEXT
      : "";
    if (emptyText !== "") {
      const empty = context.dom.createElement("div");
      empty.className = "rad-subnet-list__empty";
      empty.setAttribute(
        "style",
        "padding:4px 10px; font-size:13px; color:var(--rad-text-tertiary);"
      );
      empty.textContent = emptyText;
      list.appendChild(empty);
    }
    for (const subnet of subnets) {
      const standardZone = subnet.zoneKind === "standard";
      const row = context.dom.createElement("label");
      row.className = "rad-subnet-list__row";
      row.setAttribute(
        "style",
        `display:grid; grid-template-columns:auto 1fr auto auto; gap:16px; align-items:center; padding:4px 10px; font-size:13px; ${
          standardZone ? "cursor:pointer;" : (
            "cursor:default; color:var(--rad-text-tertiary);"
          )
        }`
      );
      const box = context.dom.createElement("input");
      box.setAttribute("type", "checkbox");
      box.setAttribute("value", subnet.id);
      box.id = `aws-subnet-${subnet.id}`;
      if (!standardZone) box.setAttribute("disabled", "");
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
      zone.textContent =
        standardZone ?
          subnet.availabilityZone
        : `${subnet.availabilityZone} (${ZONE_LABELS[subnet.zoneKind]})`;
      const routing = context.dom.createElement("span");
      routing.className = "rad-subnet-list__kind";
      routing.textContent =
        subnet.routing === "unknown" ? "routing unknown" : subnet.routing;
      row.appendChild(box);
      row.appendChild(id);
      row.appendChild(zone);
      row.appendChild(routing);
      list.appendChild(row);
    }
  };

  const restoreSubnets = (saved: readonly string[]): void => {
    const vpcId = clusterVpcId();
    for (const id of new Set(saved.filter((entry) => entry !== ""))) {
      const subnet = discovered.subnets.find((entry) => entry.id === id);
      if (subnet !== undefined && isUsableSubnet(subnet, vpcId)) {
        selected.push(id);
      } else {
        removed.push({
          id,
          reason:
            subnet?.vpcId === vpcId ?
              ZONE_LABELS[subnet.zoneKind]
            : AWS_NOT_IN_VPC_REASON
        });
      }
    }
  };

  const showCluster = (
    clusterId: string,
    subnets: "defaults" | readonly string[]
  ): void => {
    cluster =
      discovered.clusters.find(
        (entry) => entry.id === clusterId && entry.usable
      ) ?? null;
    const select = context.dom.selectById(AWS_CLUSTER_SELECT_ID);
    if (select) select.value = cluster?.id ?? "";
    selected = [];
    removed = [];
    noPrivateZones = false;
    if (cluster !== null && !subnetsFailed()) {
      if (subnets === "defaults") {
        selected = defaultAwsSubnetSelection(
          discovered.subnets,
          clusterVpcId()
        );
        // A failed route-table read has its own warning.
        noPrivateZones =
          selected.length === 0 &&
          vpcSubnets().length > 0 &&
          discovered.routeTablesErrorKind === "";
      } else {
        restoreSubnets(subnets);
      }
    }
    renderVpc();
    renderSubnets();
    renderMessages();
  };

  const clusterSelect = context.dom.selectById(AWS_CLUSTER_SELECT_ID);
  if (clusterSelect) {
    scope.on(clusterSelect, "change", () => {
      showCluster(clusterSelect.value, "defaults");
    });
  }

  return {
    setDiscovered(next) {
      discovered = next;
    },
    showCluster,
    reset() {
      discovered = EMPTY_DISCOVERY;
      showCluster("", "defaults");
    },
    vpcId: clusterVpcId,
    selectedSubnetIds: () => [...selected],
    validationError
  };
}
