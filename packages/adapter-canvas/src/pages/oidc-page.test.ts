import { describe, it, expect } from "vitest";
import { oidcPage } from "./oidc-page.js";
import { sharedCredentials } from "../shared.js";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";

const azureResult = {
  message: "Signed in to Azure",
  tenantId: "11111111-1111-1111-1111-111111111111",
  tenantName: "Contoso",
  subscriptionId: "22222222-2222-2222-2222-222222222222",
  subscriptionName: "Production",
  clientId: "33333333-3333-3333-3333-333333333333",
  clientName: "radius-deploy"
};
const awsResult = {
  message: "Validated AWS account",
  accountId: "123456789012",
  accountName: "Platform",
  region: "us-east-1"
};

describe("oidcPage — empty state", () => {
  const html = oidcPage();

  it("opens on the Azure tab with the AWS panel hidden", () => {
    expect(html).toContain(
      '<div class="tab active" id="tab-azure">Azure</div>'
    );
    expect(html).toContain('<div class="tab" id="tab-aws">AWS</div>');
    expect(html).toContain('<div id="panel-azure">');
    expect(html).toContain('<div id="panel-aws" style="display:none;">');
  });

  it("renders empty credential fields and no result banners", () => {
    expect(html).toContain('id="az-tenant" placeholder=');
    expect(html).toContain('value=""');
    expect(html).toContain('<div id="result-azure"></div>');
    expect(html).toContain('<div id="result-aws"></div>');
  });

  it("injects the generated OIDC entry exactly once", () => {
    expect(html).toContain(browserEntryMarker("oidc-page"));
    expect(html.split(browserScript("oidc-page"))).toHaveLength(2);
  });
});

describe("oidcPage — verified results", () => {
  it("reports the verified Azure identity with its names and ids", () => {
    const html = oidcPage({ oidcAzure: azureResult });
    expect(html).toContain(
      '<div class="status success">Signed in to Azure</div>'
    );
    expect(html).toContain("Contoso — 11111111-1111-1111-1111-111111111111");
    expect(html).toContain("Production — 22222222-2222-2222-2222-222222222222");
    expect(html).toContain(
      "radius-deploy — 33333333-3333-3333-3333-333333333333"
    );
    expect(html).toContain('value="11111111-1111-1111-1111-111111111111"');
  });

  it("omits the display-name separator when only an id is known", () => {
    const html = oidcPage({
      oidcAzure: {
        message: "ok",
        tenantId: "t",
        subscriptionId: "s",
        clientId: "c"
      }
    });
    expect(html).toContain(
      '<span class="field-label">Tenant</span><div class="field-value">t</div>'
    );
    expect(html).toContain(
      '<span class="field-label">Subscription</span><div class="field-value">s</div>'
    );
  });

  it("reports the verified AWS account and region", () => {
    const html = oidcPage({ oidcAws: awsResult });
    expect(html).toContain(
      '<div class="status success">Validated AWS account</div>'
    );
    expect(html).toContain("Platform — 123456789012");
    expect(html).toContain('<div class="field-value">us-east-1</div>');
    expect(html).toContain('value="123456789012"');
    expect(html).toContain('value="us-east-1"');
  });
});

describe("oidcPage — saved credentials and escaping", () => {
  it("prefills the Azure form from the persisted credential cache", () => {
    const previous = sharedCredentials.azure;
    sharedCredentials.azure = {
      tenantId: "saved-tenant",
      subscriptionId: "saved-sub",
      clientId: "saved-client"
    };
    try {
      const html = oidcPage({});
      expect(html).toContain('value="saved-tenant"');
      expect(html).toContain('value="saved-sub"');
      expect(html).toContain('value="saved-client"');
    } finally {
      if (previous === undefined) delete sharedCredentials.azure;
      else sharedCredentials.azure = previous;
    }
  });

  it("ignores a malformed persisted credential entry rather than failing to render", () => {
    const previous = sharedCredentials.azure;
    sharedCredentials.azure = "not-an-object";
    try {
      expect(oidcPage({})).toContain('id="az-tenant"');
    } finally {
      if (previous === undefined) delete sharedCredentials.azure;
      else sharedCredentials.azure = previous;
    }
  });

  it("escapes provider-supplied values in both the banner and the form", () => {
    const hostile = "<img src=x onerror=alert(1)>'\"&";
    const html = oidcPage({
      oidcAzure: {
        message: hostile,
        tenantId: hostile,
        subscriptionId: hostile,
        clientId: hostile
      },
      oidcAws: { message: hostile, accountId: hostile, region: hostile }
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(
      "&lt;img src=x onerror=alert(1)&gt;&#39;&quot;&amp;"
    );
    const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const source = block.slice("<script>".length, -"</script>".length);
      expect(() => new Function(source)).not.toThrow();
    }
  });
});
