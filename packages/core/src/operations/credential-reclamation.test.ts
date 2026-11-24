import { describe, expect, it } from "vitest";
import {
  planCredentialReclamation,
  type CredentialProvenanceRecord
} from "./credential-reclamation.js";

const context = {
  tenantId: "tenant",
  clientId: "client",
  applicationObjectId: "object",
  repoId: 5,
  environment: "dev"
};
const credential = {
  id: "credential",
  name: "github-octo-app-dev",
  subject: "repo:octo/app:environment:dev",
  issuer: "https://token.actions.githubusercontent.com",
  audiences: ["api://AzureADTokenExchange"]
};
const record: CredentialProvenanceRecord = {
  ...context,
  ...credential,
  schemaVersion: 2,
  repo: "octo/app",
  credentialId: credential.id,
  subjectConfig: { useDefault: true },
  origin: "created",
  operationId: "op-1",
  recordedAt: new Date(0).toISOString()
};

describe("credential reclamation", () => {
  it.each([
    ["repository_id", "environment"],
    ["repository", "context"],
    ["repo", "environment"]
  ])("accepts stable custom subject claims %s and %s", (repo, environment) => {
    const evidence = {
      ...record,
      subjectConfig: {
        useDefault: false,
        includeClaimKeys: [repo, environment],
        useImmutableSubject: true
      }
    };
    expect(
      planCredentialReclamation([credential], [evidence], context)
    ).toEqual({
      delete: [{ credential, record: evidence }],
      retain: []
    });
  });

  it.each([undefined, ["environment"], ["repository_id"]])(
    "keeps credentials with incomplete custom subject claims: %j",
    (includeClaimKeys) => {
      const evidence = {
        ...record,
        subjectConfig: {
          useDefault: false,
          includeClaimKeys,
          useImmutableSubject: true
        }
      };
      expect(
        planCredentialReclamation([credential], [evidence], context)
      ).toEqual({
        delete: [],
        retain: [{ credential, reason: "shared-custom-subject" }]
      });
    }
  );

  it("keeps a credential whose live audience set grew", () => {
    const changed = {
      ...credential,
      audiences: [...credential.audiences, "another-audience"]
    };
    expect(planCredentialReclamation([changed], [record], context)).toEqual({
      delete: [],
      retain: [{ credential: changed, reason: "evidence-changed" }]
    });
  });
});
