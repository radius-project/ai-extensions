// Canvas adapter — the cloud-accounts (OIDC federation) page.
//
// Two provider panels share one endpoint. Everything the page shows about an
// identity comes back from that endpoint, so responses are validated and
// rendered as text nodes rather than re-entering the document as markup.

import { setChildren } from "./dom.js";
import { beginEntry, NOOP_TEARDOWN } from "./lifecycle.js";
import { readBoolean, readString } from "./json.js";
import type { ElementSpec } from "./dom.js";
import type { BrowserTeardown } from "./lifecycle.js";
import type {
  AbortHandle,
  BrowserContext,
  DomElement,
  DomInputElement
} from "./ports.js";

export const OIDC_ENTRY_KEY = "oidc-page";
export const OIDC_ENDPOINT = "/api/oidc";
export const OIDC_AZURE_BUTTON_LABEL = "Confirm authentication";

export interface AzureOidcRequest {
  provider: "azure";
  tenantId: string;
  subscriptionId: string;
  clientId: string;
}

export interface AwsOidcRequest {
  provider: "aws";
  accountId: string;
  region: string;
}

function field(label: string, value: string): ElementSpec {
  return {
    tag: "div",
    className: "field",
    children: [
      { tag: "span", className: "field-label", text: label },
      { tag: "div", className: "field-value", text: value }
    ]
  };
}

function status(
  tone: "error" | "info" | "success",
  message: string
): ElementSpec {
  return { tag: "div", className: `status ${tone}`, text: message };
}

function preferred(response: unknown, key: string, fallback: string): string {
  const value = readString(response, key);
  return value === "" ? fallback : value;
}

export function azureOidcResultSpecs(
  response: unknown,
  request: AzureOidcRequest
): readonly ElementSpec[] {
  if (!readBoolean(response, "validated")) {
    const message = readString(response, "message");
    return [
      status("error", message === "" ? "Authentication failed" : message)
    ];
  }
  const subscriptionName = readString(response, "subscriptionName");
  const userName = readString(response, "userName");
  const specs: ElementSpec[] = [
    status("success", readString(response, "message")),
    field("Tenant", preferred(response, "tenantId", request.tenantId)),
    field(
      "Subscription",
      `${subscriptionName === "" ? "" : `${subscriptionName} — `}${preferred(
        response,
        "subscriptionId",
        request.subscriptionId
      )}`
    )
  ];
  if (request.clientId !== "") {
    specs.push(field("App Registration", request.clientId));
  }
  if (userName !== "") specs.push(field("Signed in as", userName));
  return specs;
}

export function awsOidcResultSpecs(
  response: unknown,
  request: AwsOidcRequest
): readonly ElementSpec[] {
  return [
    status("success", readString(response, "message")),
    field("Account", request.accountId),
    field("Region", request.region)
  ];
}

export function oidcErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message
    : typeof error === "string" && error !== "" ? error
    : "Authentication failed.";
  return `Error: ${message}`;
}

function inputValue(input: DomInputElement | null): string {
  return input ? input.value : "";
}

function postOidc(
  context: BrowserContext,
  body: AzureOidcRequest | AwsOidcRequest,
  abort: AbortHandle | null
): Promise<unknown> {
  return context.net
    .fetch(OIDC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(abort ? { signal: abort.signal } : {})
    })
    .then(async (response) => {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Radius returned an invalid authentication response.");
      }
      if (!response.ok) {
        throw new Error(
          readString(payload, "error") ||
            readString(payload, "message") ||
            "Authentication failed."
        );
      }
      return payload;
    });
}

interface TabPair {
  readonly tab: DomElement;
  readonly panel: DomElement;
}

function activate(active: TabPair, inactive: TabPair): void {
  active.tab.classList.add("active");
  inactive.tab.classList.remove("active");
  active.panel.style.display = "block";
  inactive.panel.style.display = "none";
}

export function initializeOidcPage(context: BrowserContext): BrowserTeardown {
  const azureTab = context.dom.byId("tab-azure");
  const awsTab = context.dom.byId("tab-aws");
  const azurePanel = context.dom.byId("panel-azure");
  const awsPanel = context.dom.byId("panel-aws");
  const azureButton = context.dom.inputById("btn-azure");
  const awsButton = context.dom.inputById("btn-aws");
  const azureResult = context.dom.byId("result-azure");
  const awsResult = context.dom.byId("result-aws");
  if (
    !azureTab ||
    !awsTab ||
    !azurePanel ||
    !awsPanel ||
    !azureButton ||
    !awsButton ||
    !azureResult ||
    !awsResult
  ) {
    return NOOP_TEARDOWN;
  }

  const scope = beginEntry(context, OIDC_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;

  const azure: TabPair = { tab: azureTab, panel: azurePanel };
  const aws: TabPair = { tab: awsTab, panel: awsPanel };
  let azureRequest = 0;
  let awsRequest = 0;
  let azureAbort: AbortHandle | null = null;
  let awsAbort: AbortHandle | null = null;

  const renderStatus = (
    host: DomElement,
    tone: "error" | "info" | "success",
    message: string
  ): void => {
    setChildren(context.dom, host, [status(tone, message)]);
  };

  scope.on(azureTab, "click", () => {
    activate(azure, aws);
  });
  scope.on(awsTab, "click", () => {
    activate(aws, azure);
  });

  scope.on(azureButton, "click", () => {
    const request: AzureOidcRequest = {
      provider: "azure",
      tenantId: inputValue(context.dom.inputById("az-tenant")).trim(),
      subscriptionId: inputValue(context.dom.inputById("az-sub")).trim(),
      clientId: inputValue(context.dom.inputById("az-client")).trim()
    };
    if (request.tenantId === "" || request.subscriptionId === "") {
      renderStatus(
        azureResult,
        "error",
        "Enter both a tenant ID and subscription ID."
      );
      return;
    }
    azureAbort?.abort();
    azureAbort = context.net.createAbort();
    const token = ++azureRequest;
    azureButton.disabled = true;
    azureButton.textContent = "Authenticating...";
    renderStatus(
      azureResult,
      "info",
      "🔐 Signing in to Azure... A browser window may open."
    );
    void postOidc(context, request, azureAbort).then(
      (response) => {
        if (!scope.active || token !== azureRequest) return;
        azureAbort = null;
        azureButton.disabled = false;
        azureButton.textContent = OIDC_AZURE_BUTTON_LABEL;
        setChildren(
          context.dom,
          azureResult,
          azureOidcResultSpecs(response, request)
        );
      },
      (error: unknown) => {
        if (!scope.active || token !== azureRequest) return;
        azureAbort = null;
        azureButton.disabled = false;
        azureButton.textContent = OIDC_AZURE_BUTTON_LABEL;
        renderStatus(azureResult, "error", oidcErrorMessage(error));
      }
    );
  });

  scope.on(awsButton, "click", () => {
    const request: AwsOidcRequest = {
      provider: "aws",
      accountId: inputValue(context.dom.inputById("aws-account")).trim(),
      region: inputValue(context.dom.inputById("aws-region")).trim()
    };
    if (request.accountId === "" || request.region === "") {
      renderStatus(awsResult, "error", "Enter both an account ID and region.");
      return;
    }
    awsAbort?.abort();
    awsAbort = context.net.createAbort();
    const token = ++awsRequest;
    awsButton.disabled = true;
    renderStatus(awsResult, "info", "Validating...");
    void postOidc(context, request, awsAbort).then(
      (response) => {
        if (!scope.active || token !== awsRequest) return;
        awsAbort = null;
        awsButton.disabled = false;
        setChildren(
          context.dom,
          awsResult,
          awsOidcResultSpecs(response, request)
        );
      },
      (error: unknown) => {
        if (!scope.active || token !== awsRequest) return;
        awsAbort = null;
        awsButton.disabled = false;
        renderStatus(awsResult, "error", oidcErrorMessage(error));
      }
    );
  });

  return () => {
    azureRequest += 1;
    awsRequest += 1;
    azureAbort?.abort();
    awsAbort?.abort();
    azureAbort = null;
    awsAbort = null;
    scope.teardown();
  };
}
