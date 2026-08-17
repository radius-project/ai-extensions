import { describe, expect, it } from "vitest";
import {
  OIDC_AZURE_BUTTON_LABEL,
  OIDC_ENDPOINT,
  OIDC_ENTRY_KEY,
  awsOidcResultSpecs,
  azureOidcResultSpecs,
  initializeOidcPage,
  oidcErrorMessage
} from "./oidc.js";
import { setChildren } from "./dom.js";
import {
  createFakeBrowser,
  createFakeElement,
  createFakeInput,
  fakeText,
  fakeTree,
  flushPromises,
  jsonResponse,
  textResponse
} from "../../test/support/browser/fakes.js";
import type { ElementSpec } from "./dom.js";
import type { FakeBrowser } from "../../test/support/browser/fakes.js";

const HOSTILE = "<img src=x onerror=alert(1)>'\"&";

function renderSpecs(specs: readonly ElementSpec[]) {
  const browser = createFakeBrowser();
  const host = createFakeElement("host");
  setChildren(browser.context.dom, host, specs);
  return host;
}

interface OidcPage {
  browser: FakeBrowser;
  azureTab: ReturnType<typeof createFakeElement>;
  awsTab: ReturnType<typeof createFakeElement>;
  azurePanel: ReturnType<typeof createFakeElement>;
  awsPanel: ReturnType<typeof createFakeElement>;
  azureButton: ReturnType<typeof createFakeInput>;
  awsButton: ReturnType<typeof createFakeInput>;
  azureResult: ReturnType<typeof createFakeElement>;
  awsResult: ReturnType<typeof createFakeElement>;
  tenant: ReturnType<typeof createFakeInput>;
  subscription: ReturnType<typeof createFakeInput>;
  client: ReturnType<typeof createFakeInput>;
  account: ReturnType<typeof createFakeInput>;
  region: ReturnType<typeof createFakeInput>;
}

function renderOidcPage(): OidcPage {
  const browser = createFakeBrowser();
  const azureTab = createFakeElement("tab-azure");
  azureTab.className = "tab active";
  const awsTab = createFakeElement("tab-aws");
  awsTab.className = "tab";
  const azurePanel = createFakeElement("panel-azure");
  const awsPanel = createFakeElement("panel-aws");
  awsPanel.style.display = "none";
  const azureButton = createFakeInput("btn-azure");
  azureButton.textContent = OIDC_AZURE_BUTTON_LABEL;
  const awsButton = createFakeInput("btn-aws");
  const azureResult = createFakeElement("result-azure");
  const awsResult = createFakeElement("result-aws");
  const tenant = createFakeInput("az-tenant", " tenant-1 ");
  const subscription = createFakeInput("az-sub", " sub-1 ");
  const client = createFakeInput("az-client", " client-1 ");
  const account = createFakeInput("aws-account", "123456789012");
  const region = createFakeInput("aws-region", "us-east-1");
  for (const element of [
    azureTab,
    awsTab,
    azurePanel,
    awsPanel,
    azureButton,
    awsButton,
    azureResult,
    awsResult,
    tenant,
    subscription,
    client,
    account,
    region
  ]) {
    browser.document.add(element);
  }
  return {
    browser,
    azureTab,
    awsTab,
    azurePanel,
    awsPanel,
    azureButton,
    awsButton,
    azureResult,
    awsResult,
    tenant,
    subscription,
    client,
    account,
    region
  };
}

describe("azureOidcResultSpecs", () => {
  it("reports the verified identity with the response's own names", () => {
    const host = renderSpecs(
      azureOidcResultSpecs(
        {
          validated: true,
          message: "Signed in",
          tenantId: "server-tenant",
          subscriptionId: "server-sub",
          subscriptionName: "Production",
          userName: "octocat"
        },
        {
          provider: "azure",
          tenantId: "typed-tenant",
          subscriptionId: "typed-sub",
          clientId: "typed-client"
        }
      )
    );

    expect(host.children[0].className).toBe("status success");
    expect(fakeText(host)).toBe(
      "Signed inTenantserver-tenantSubscriptionProduction — server-subApp Registrationtyped-clientSigned in asoctocat"
    );
  });

  it("falls back to typed values and omits optional rows", () => {
    const host = renderSpecs(
      azureOidcResultSpecs(
        { validated: true, message: "ok" },
        {
          provider: "azure",
          tenantId: "typed-tenant",
          subscriptionId: "typed-sub",
          clientId: ""
        }
      )
    );
    expect(fakeText(host)).toBe("okTenanttyped-tenantSubscriptiontyped-sub");
  });

  it("reports an unvalidated response as an error with a default message", () => {
    const request = {
      provider: "azure" as const,
      tenantId: "t",
      subscriptionId: "s",
      clientId: "c"
    };
    expect(
      fakeText(renderSpecs(azureOidcResultSpecs({ validated: false }, request)))
    ).toBe("Authentication failed");
    expect(
      fakeText(
        renderSpecs(
          azureOidcResultSpecs({ validated: false, message: "denied" }, request)
        )
      )
    ).toBe("denied");
    expect(fakeText(renderSpecs(azureOidcResultSpecs(null, request)))).toBe(
      "Authentication failed"
    );
  });

  it("keeps every hostile value in text nodes", () => {
    const host = renderSpecs(
      azureOidcResultSpecs(
        {
          validated: true,
          message: HOSTILE,
          tenantId: HOSTILE,
          subscriptionName: HOSTILE,
          subscriptionId: HOSTILE,
          userName: HOSTILE
        },
        {
          provider: "azure",
          tenantId: HOSTILE,
          subscriptionId: HOSTILE,
          clientId: HOSTILE
        }
      )
    );
    expect(fakeText(host)).toContain(HOSTILE);
    expect(fakeTree(host).every((element) => element.innerHTML === "")).toBe(
      true
    );
  });
});

describe("awsOidcResultSpecs", () => {
  it("reports the account and region the user submitted", () => {
    const host = renderSpecs(
      awsOidcResultSpecs(
        { message: "Validated" },
        { provider: "aws", accountId: "123456789012", region: "us-east-1" }
      )
    );
    expect(fakeText(host)).toBe("ValidatedAccount123456789012Regionus-east-1");
  });

  it("keeps every hostile value in text nodes", () => {
    const host = renderSpecs(
      awsOidcResultSpecs(
        { message: HOSTILE },
        { provider: "aws", accountId: HOSTILE, region: HOSTILE }
      )
    );
    expect(fakeText(host)).toContain(HOSTILE);
    expect(fakeTree(host).every((element) => element.innerHTML === "")).toBe(
      true
    );
  });
});

describe("oidcErrorMessage", () => {
  it("keeps explicit Error and string details without stringifying payloads", () => {
    expect(oidcErrorMessage(new Error("offline"))).toBe("Error: offline");
    expect(oidcErrorMessage("denied")).toBe("Error: denied");
    expect(oidcErrorMessage({ secret: "do-not-render" })).toBe(
      "Error: Authentication failed."
    );
    expect(oidcErrorMessage("")).toBe("Error: Authentication failed.");
  });
});

describe("initializeOidcPage", () => {
  it("switches panels when a provider tab is clicked", () => {
    const page = renderOidcPage();
    initializeOidcPage(page.browser.context);

    page.awsTab.dispatch("click");
    expect(page.awsTab.className).toContain("active");
    expect(page.azureTab.className).not.toContain("active");
    expect(page.awsPanel.style.display).toBe("block");
    expect(page.azurePanel.style.display).toBe("none");

    page.azureTab.dispatch("click");
    expect(page.azureTab.className).toContain("active");
    expect(page.awsTab.className).not.toContain("active");
    expect(page.azurePanel.style.display).toBe("block");
    expect(page.awsPanel.style.display).toBe("none");
  });

  it("posts the trimmed Azure form and restores the button on success", async () => {
    const page = renderOidcPage();
    page.browser.net.handle(OIDC_ENDPOINT, () =>
      jsonResponse({ validated: true, message: "Signed in" })
    );
    initializeOidcPage(page.browser.context);

    page.azureButton.dispatch("click");
    expect(page.azureButton.disabled).toBe(true);
    expect(page.azureButton.textContent).toBe("Authenticating...");
    expect(fakeText(page.azureResult)).toContain("Signing in to Azure");

    await flushPromises();
    expect(page.browser.net.calls).toHaveLength(1);
    expect(JSON.parse(String(page.browser.net.calls[0].init?.body))).toEqual({
      provider: "azure",
      tenantId: "tenant-1",
      subscriptionId: "sub-1",
      clientId: "client-1"
    });
    expect(page.azureButton.disabled).toBe(false);
    expect(page.azureButton.textContent).toBe(OIDC_AZURE_BUTTON_LABEL);
    expect(fakeText(page.azureResult)).toContain("Signed in");
    expect(
      fakeTree(page.azureResult).every((element) => element.innerHTML === "")
    ).toBe(true);
  });

  it("restores the Azure button and reports request failure", async () => {
    const page = renderOidcPage();
    page.browser.net.handle(OIDC_ENDPOINT, () =>
      Promise.reject(new Error("network down"))
    );
    initializeOidcPage(page.browser.context);

    page.azureButton.dispatch("click");
    await flushPromises();

    expect(page.azureButton.disabled).toBe(false);
    expect(page.azureButton.textContent).toBe(OIDC_AZURE_BUTTON_LABEL);
    expect(fakeText(page.azureResult)).toBe("Error: network down");
  });

  it("posts the AWS form and renders its result", async () => {
    const page = renderOidcPage();
    page.browser.net.handle(OIDC_ENDPOINT, () =>
      jsonResponse({ message: "Validated" })
    );
    initializeOidcPage(page.browser.context);

    page.awsButton.dispatch("click");
    expect(page.awsButton.disabled).toBe(true);
    expect(fakeText(page.awsResult)).toContain("Validating...");
    await flushPromises();

    expect(JSON.parse(String(page.browser.net.calls[0].init?.body))).toEqual({
      provider: "aws",
      accountId: "123456789012",
      region: "us-east-1"
    });
    expect(page.awsButton.disabled).toBe(false);
    expect(fakeText(page.awsResult)).toContain("Validated");
    expect(fakeText(page.awsResult)).toContain("us-east-1");
  });

  it("reports an AWS request failure in its own panel", async () => {
    const page = renderOidcPage();
    page.browser.net.handle(OIDC_ENDPOINT, () =>
      Promise.reject(new Error("boom"))
    );
    initializeOidcPage(page.browser.context);

    page.awsButton.dispatch("click");
    await flushPromises();
    expect(page.awsButton.disabled).toBe(false);
    expect(fakeText(page.awsResult)).toBe("Error: boom");
  });

  it("validates required provider fields before making a request", async () => {
    const page = renderOidcPage();
    const bare = createFakeBrowser();
    for (const element of [
      page.azureTab,
      page.awsTab,
      page.azurePanel,
      page.awsPanel,
      page.azureButton,
      page.awsButton,
      page.azureResult,
      page.awsResult
    ]) {
      bare.document.add(element);
    }
    initializeOidcPage(bare.context);

    page.azureButton.dispatch("click");
    page.awsButton.dispatch("click");
    expect(bare.net.calls).toHaveLength(0);
    expect(fakeText(page.azureResult)).toBe(
      "Enter both a tenant ID and subscription ID."
    );
    expect(fakeText(page.awsResult)).toBe(
      "Enter both an account ID and region."
    );
  });

  it.each([
    [
      "an explicit HTTP error",
      jsonResponse({ error: "denied" }, false, 403),
      "Error: denied"
    ],
    [
      "an HTTP message",
      jsonResponse({ message: "unavailable" }, false, 503),
      "Error: unavailable"
    ],
    [
      "an empty HTTP failure",
      jsonResponse({}, false, 500),
      "Error: Authentication failed."
    ],
    [
      "malformed JSON",
      textResponse("not json", false, 500),
      "Error: Radius returned an invalid authentication response."
    ]
  ])("reports %s explicitly", async (_label, serverResponse, expected) => {
    const page = renderOidcPage();
    page.browser.net.handle(OIDC_ENDPOINT, () => serverResponse);
    initializeOidcPage(page.browser.context);

    page.azureButton.dispatch("click");
    await flushPromises();

    expect(fakeText(page.azureResult)).toBe(expected);
    expect(fakeText(page.azureResult)).not.toContain("tenant-1");
  });

  it("ignores an older overlapping response and aborts it", async () => {
    const page = renderOidcPage();
    let resolveFirst: (() => void) | undefined;
    let request = 0;
    page.browser.net.handle(OIDC_ENDPOINT, () => {
      request += 1;
      if (request === 1) {
        return new Promise((resolve) => {
          resolveFirst = () =>
            resolve(jsonResponse({ validated: true, message: "stale" }));
        });
      }
      return jsonResponse({ validated: true, message: "current" });
    });
    initializeOidcPage(page.browser.context);

    page.azureButton.dispatch("click");
    page.azureButton.dispatch("click");
    await flushPromises();
    resolveFirst?.();
    await flushPromises();

    expect(page.browser.net.aborted).toBe(1);
    expect(fakeText(page.azureResult)).toContain("current");
    expect(fakeText(page.azureResult)).not.toContain("stale");
  });

  it("ignores an older successful response when abort is unavailable", async () => {
    const page = renderOidcPage();
    page.browser.net.supportsAbort = false;
    let resolveFirst: (() => void) | undefined;
    let request = 0;
    page.browser.net.handle(OIDC_ENDPOINT, () => {
      request += 1;
      if (request === 1) {
        return new Promise((resolve) => {
          resolveFirst = () =>
            resolve(jsonResponse({ validated: true, message: "stale" }));
        });
      }
      return jsonResponse({ validated: true, message: "current" });
    });
    initializeOidcPage(page.browser.context);

    page.azureButton.dispatch("click");
    await flushPromises();
    page.azureButton.dispatch("click");
    await flushPromises();
    resolveFirst?.();
    await flushPromises();

    expect(fakeText(page.azureResult)).toContain("current");
    expect(fakeText(page.azureResult)).not.toContain("stale");
  });

  it("does not apply a successful response after teardown and supports browsers without abort", async () => {
    const page = renderOidcPage();
    page.browser.net.supportsAbort = false;
    let resolveRequest: (() => void) | undefined;
    page.browser.net.handle(
      OIDC_ENDPOINT,
      () =>
        new Promise((resolve) => {
          resolveRequest = () => resolve(jsonResponse({ message: "too late" }));
        })
    );
    const teardown = initializeOidcPage(page.browser.context);

    page.awsButton.dispatch("click");
    await flushPromises();
    teardown();
    resolveRequest?.();
    await flushPromises();

    expect(fakeText(page.awsResult)).toBe("Validating...");
    expect(page.awsButton.disabled).toBe(true);
  });

  it("does not apply a rejected AWS response after teardown", async () => {
    const page = renderOidcPage();
    page.browser.net.supportsAbort = false;
    let rejectRequest: (() => void) | undefined;
    page.browser.net.handle(
      OIDC_ENDPOINT,
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = () => reject(new Error("too late"));
        })
    );
    const teardown = initializeOidcPage(page.browser.context);

    page.awsButton.dispatch("click");
    await flushPromises();
    teardown();
    rejectRequest?.();
    await flushPromises();

    expect(fakeText(page.awsResult)).toBe("Validating...");
  });

  it("binds once per page and unbinds everything on teardown", () => {
    const page = renderOidcPage();
    const teardown = initializeOidcPage(page.browser.context);
    const bound = page.azureTab.listenerCount("click");
    expect(bound).toBe(1);

    const second = initializeOidcPage(page.browser.context);
    expect(page.azureTab.listenerCount("click")).toBe(bound);
    second();

    teardown();
    for (const element of [
      page.azureTab,
      page.awsTab,
      page.azureButton,
      page.awsButton
    ]) {
      expect(element.listenerCount()).toBe(0);
    }
    expect(page.browser.bindings.has(OIDC_ENTRY_KEY)).toBe(false);

    initializeOidcPage(page.browser.context);
    expect(page.azureTab.listenerCount("click")).toBe(1);
  });

  it("does nothing on a page that has no accounts markup", () => {
    const browser = createFakeBrowser();
    expect(() => initializeOidcPage(browser.context)()).not.toThrow();
    expect(browser.bindings.has(OIDC_ENTRY_KEY)).toBe(false);
  });
});
