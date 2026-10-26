// Reads a session's `$HOME/.copilot/session-state/<id>/events.jsonl`, where
// the agent runtime records what the agent did.

import { hasText, isJsonObject, parseJson } from "./json.mjs";

function addOnce(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

/** The `session.usage_record` fields to add up, by summary field. */
const USAGE_FIELDS = {
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  cacheReadTokens: "cacheReadTokens",
  cacheWriteTokens: "cacheWriteTokens",
  reasoningTokens: "reasoningTokens",
  apiDurationMs: "duration"
};

/**
 * Adds one model call's usage to the totals. The CLI writes one
 * `session.usage_record` for each model call, and it can stop before it writes
 * the totals in `session.shutdown`.
 */
function addUsage(totals, usage) {
  totals.calls += 1;

  for (const [total, field] of Object.entries(USAGE_FIELDS))
    if (Number.isFinite(usage[field])) totals[total] += usage[field];
}

/**
 * Summarizes one `events.jsonl` file. A line that is not JSON is skipped,
 * because the runtime can be writing the last line.
 */
export function summarizeSessionEvents(jsonl) {
  let state = { kind: "running" };
  const models = [];
  const skills = [];
  const tools = {};

  const usage = {
    calls: 0,
    ...Object.fromEntries(Object.keys(USAGE_FIELDS).map((name) => [name, 0]))
  };
  let completion;
  let lastMessage;

  for (const line of jsonl.split("\n")) {
    const event = parseJson(line);

    if (!isJsonObject(event) || !isJsonObject(event.data)) continue;
    const data = event.data;

    const text = (key) =>
      hasText(data, key) ? data[key].trim() || undefined : undefined;

    switch (event.type) {
      case "assistant.message":
        addOnce(models, text("model"));
        lastMessage = text("content") ?? lastMessage;
        break;
      case "skill.invoked": {
        // A plugin's skill is recorded as `<plugin>:<skill>`, so a project
        // skill with the same name cannot pass for it.
        const name = text("name");
        const plugin = text("pluginName");
        addOnce(skills, name && plugin ? `${plugin}:${name}` : name);
        break;
      }
      case "tool.execution_start": {
        const name = text("toolName");

        if (name) tools[name] = (tools[name] ?? 0) + 1;
        break;
      }

      case "session.usage_record":
        if (isJsonObject(data.usage)) addUsage(usage, data.usage);
        break;
      case "session.task_complete":
        state = { kind: "completed" };
        completion = text("summary") ?? completion;
        break;
      case "session.error":
        state = {
          kind: "failed",
          error: text("message") ?? "The session reported an error."
        };
        break;
    }
  }

  return {
    state,
    models,
    skills,
    tools,
    usage,
    finalReply: completion ?? lastMessage
  };
}
