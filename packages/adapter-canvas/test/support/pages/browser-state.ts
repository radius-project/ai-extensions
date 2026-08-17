import { expect } from "vitest";

function decodeHtmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function readBrowserPageState(
  html: string,
  elementId: string
): Record<string, unknown> {
  const escaped = elementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`<div hidden id="${escaped}">([\\s\\S]*?)</div>`)
  );
  expect(match, `${elementId} is not emitted`).toBeTruthy();
  const parsed: unknown = JSON.parse(decodeHtmlText(match?.[1] ?? ""));
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}
