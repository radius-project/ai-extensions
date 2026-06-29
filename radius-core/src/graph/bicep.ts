// Bicep → ARM → graph extraction.
//
// `compileBicepToARM` shells out to the local bicep CLI (best-effort);
// `parseBicepResources` is a CLI-free regex fallback; `buildGraphFromBicep`
// orchestrates the two so callers get the same graph shape regardless of which
// path ran. All deterministic given the same inputs.

import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addInboundConnections,
  buildModeledGraph,
  buildResourceID,
  stripAPIVersion,
} from "./model.js";

/**
 * compileBicepToARM - attempts to compile bicep to ARM JSON using the bicep CLI.
 * Returns the ARM JSON template object or null if bicep CLI is unavailable.
 */
export function compileBicepToARM(bicepContent: string): Promise<any> {
  return new Promise((resolve) => {
    // Write bicep to a temp file, compile with bicep CLI
    const tmpFile = join(tmpdir(), `radius-${Date.now()}.bicep`);
    const outFile = tmpFile.replace(".bicep", ".json");
    try {
      writeFileSync(tmpFile, bicepContent);
    } catch {
      resolve(null);
      return;
    }

    // Try `bicep build` first, then `az bicep build`
    execFile("bicep", ["build", tmpFile, "--stdout"], { timeout: 30000 }, (err, stdout) => {
      if (!err && stdout) {
        try { unlinkSync(tmpFile); } catch {}
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
        return;
      }
      execFile("az", ["bicep", "build", "--file", tmpFile, "--stdout"], { shell: true, timeout: 30000 }, (err2, stdout2) => {
        try { unlinkSync(tmpFile); } catch {}
        try { unlinkSync(outFile); } catch {}
        if (!err2 && stdout2) {
          try { resolve(JSON.parse(stdout2)); } catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
  });
}

/**
 * buildGraphFromBicep - high-level: tries bicep CLI compilation + vendored
 * BuildModeledGraph, falls back to regex parsing if CLI unavailable.
 */
export async function buildGraphFromBicep(
  bicepContent: string,
  definitionFile = ".radius/app.bicep",
): Promise<any[]> {
  if (!bicepContent) return [];
  // Try the vendored path: bicep build → BuildModeledGraph
  const armTemplate = await compileBicepToARM(bicepContent);
  if (armTemplate) {
    const graph = buildModeledGraph(armTemplate);
    if (graph.resources.length > 0) {
      // Enrich with definitionFile metadata for code navigation
      for (const r of graph.resources) {
        r.definitionFile = definitionFile;
      }
      return graph.resources;
    }
  }
  // Fallback: regex-based parser (works without bicep CLI)
  return parseBicepResources(bicepContent, definitionFile);
}

export function parseBicepResources(content: string, definitionFile = ".radius/app.bicep"): any[] {
  if (!content) return [];
  const resources: any[] = [];
  const resourceNames: any[] = [];
  const nameRegex = /resource\s+(\w+)\s+'([^']+)'/g;
  let match;
  while ((match = nameRegex.exec(content)) !== null) {
    // Track the line number of the resource declaration
    const linesBefore = content.slice(0, match.index).split("\n");
    const defLine = linesBefore.length;
    resourceNames.push({ symName: match[1], type: match[2], defLine });
  }

  // Build a symbolic-name lookup first so connection ids can be constructed
  // identically to the modeled-graph (ARM) path: stripped resource type +
  // resource `name` value, via buildResourceID(). This keeps node identity
  // consistent regardless of which code path buildGraphFromBicep() takes.
  const symInfo = new Map<string, any>();
  for (const res of resourceNames) {
    const blockStart = content.indexOf(`resource ${res.symName} `);
    let block = "";
    if (blockStart !== -1) {
      const blockEnd = content.indexOf(`\nresource `, blockStart + 1);
      block = blockEnd > blockStart ? content.slice(blockStart, blockEnd) : content.slice(blockStart);
    }
    const nameMatch = block.match(/name:\s*'([^']+)'/);
    symInfo.set(res.symName, {
      strippedType: stripAPIVersion(res.type),
      displayName: nameMatch ? nameMatch[1] : res.symName,
      block,
      defLine: res.defLine,
    });
  }

  // Check if application is a param (not a defined resource) — synthesize an app node
  const hasAppParam = /param\s+application\s+string/i.test(content);
  const hasAppResource = resourceNames.some((r) => r.type.includes("applications"));
  let appNodeId: string | null = null;
  if (hasAppParam && !hasAppResource) {
    // Infer app name from the first resource's name or use a default
    const firstNameMatch = content.match(/name:\s*'([^']+)'/);
    const appName = firstNameMatch ? firstNameMatch[1].replace(/-?(app|container|db|route|gateway).*$/i, "") || "app" : "app";
    appNodeId = buildResourceID("Radius.Core/applications", "application");
    resources.push({
      name: appName,
      type: "Radius.Core/applications",
      id: appNodeId,
      connections: [],
      codeReference: "",
      definitionFile: definitionFile,
      definitionLine: 0,
    });
  }

  for (const res of resourceNames) {
    const info = symInfo.get(res.symName);
    if (!info) continue;
    const block = info.block;
    const connections = [];
    for (const other of resourceNames) {
      if (other.symName === res.symName) continue;
      const refPattern = new RegExp(`\\b${other.symName}\\.(id|name|properties)`, "g");
      if (refPattern.test(block)) {
        const otherInfo = symInfo.get(other.symName);
        connections.push({
          id: buildResourceID(otherInfo.strippedType, otherInfo.displayName),
          name: otherInfo.displayName,
          direction: "Outbound",
        });
      }
    }
    // If resource references 'application' param, add connection to synthesized app node
    if (appNodeId && /application:\s*(application|app)\b/.test(block)) {
      connections.push({
        id: appNodeId,
        name: "application",
        direction: "Outbound",
      });
    }
    // Extract codeReference property if present
    const codeRefMatch = block.match(/codeReference:\s*'([^']+)'/);
    const codeReference = codeRefMatch ? codeRefMatch[1] : "";

    resources.push({
      name: info.displayName,
      type: info.strippedType,
      id: buildResourceID(info.strippedType, info.displayName),
      connections,
      codeReference,
      definitionFile: definitionFile,
      definitionLine: info.defLine,
    });
  }

  // Mirror the modeled-graph (ARM) path so both code paths produce
  // structurally identical graphs (outbound + inbound connections).
  addInboundConnections({ resources });
  return resources;
}
