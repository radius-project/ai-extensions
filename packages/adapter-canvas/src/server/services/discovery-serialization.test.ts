import { expect, it } from "vitest";
import {
  portFailure,
  portForbidden,
  portSuccess
} from "@radius-project/core/lifecycle";
import { serializeLegacyApplications } from "./discovery-serialization.js";

it("projects canonical identities and confirmed absence without inventing application evidence", () => {
  const observation = {
    quality: "current" as const,
    completeness: "partial" as const,
    evidence: "source" as const
  };
  expect(
    serializeLegacyApplications(
      "owner/repo",
      portSuccess({ target: { repo: "owner/repo" }, items: [], observation })
    )
  ).toEqual({ applications: [] });
  expect(
    serializeLegacyApplications(
      "owner/repo",
      portSuccess({
        target: { repo: "owner/repo" },
        items: [
          { target: { repo: "owner/repo", application: "app" }, observation }
        ],
        observation
      })
    )
  ).toEqual({ applications: [{ name: "app" }] });
});
it("marks the legacy basename display fallback with an explicit canonical failure", () => {
  expect(
    serializeLegacyApplications("owner/repo", portForbidden())
  ).toMatchObject({
    applications: [{ name: "repo" }],
    error: expect.stringContaining("FORBIDDEN")
  });
});
it("keeps an explicit failure when an invalid legacy label has no basename", () => {
  expect(
    serializeLegacyApplications("owner/", portFailure("INVALID_REQUEST"))
  ).toMatchObject({
    applications: [{ name: "owner/" }],
    error: expect.stringContaining("INVALID_REQUEST")
  });
});
it("preserves the legacy single-application picker without hiding its projection limit", () => {
  const observation = {
    quality: "current" as const,
    completeness: "partial" as const,
    evidence: "source" as const
  };
  const result = portSuccess({
    target: { repo: "owner/repo" },
    items: ["primary", "secondary"].map((application) => ({
      target: { repo: "owner/repo", application },
      observation
    })),
    observation
  });
  expect(serializeLegacyApplications("owner/repo", result)).toMatchObject({
    applications: [{ name: "primary" }],
    error: expect.stringContaining("first canonical application")
  });
});
