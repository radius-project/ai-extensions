const APPLICATION_NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;

/** Only a single literal application resource; dynamic and modular models stay unknown. */
export function literalWorkflowApplication(source: string): string | null {
  const tokens: {
    value: string;
    literal?: string;
    end: number;
    start: number;
  }[] = [];
  for (let cursor = 0; cursor < source.length;) {
    const start = cursor;
    const first = source[cursor];
    if (/\s/.test(first)) {
      cursor++;
      continue;
    }
    if (source.startsWith("//", cursor)) {
      cursor += 2;
      while (
        cursor < source.length &&
        source[cursor] !== "\r" &&
        source[cursor] !== "\n"
      )
        cursor++;
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      if (end === -1) return null;
      cursor = end + 2;
      continue;
    }
    if (first === "'") {
      cursor++;
      let closed = false;
      while (cursor < source.length) {
        const character = source[cursor++];
        if (character === "\\") {
          if (cursor === source.length) return null;
          cursor++;
        } else if (character === "'") {
          closed = true;
          break;
        }
      }
      if (!closed) return null;
    } else if (/[A-Za-z_]/.test(first)) {
      cursor++;
      while (cursor < source.length && /[A-Za-z_0-9]/.test(source[cursor]))
        cursor++;
    } else cursor++;
    const value = source.slice(start, cursor);
    tokens.push({
      value,
      ...(value.startsWith("'") ? { literal: value.slice(1, -1) } : {}),
      start,
      end: cursor
    });
  }
  if (tokens.some((token) => token.value === "module")) return null;
  let application: string | null = null;
  let resources = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== "resource") continue;
    const type = tokens[index + 2]?.literal;
    if (!type || !/^Radius\.Core\/applications@[^'\\]+$/i.test(type)) continue;
    if (
      ++resources !== 1 ||
      tokens[index + 3]?.value !== "=" ||
      tokens[index + 4]?.value !== "{"
    )
      return null;
    let depth = 1;
    let names = 0;
    for (
      let cursor = index + 5;
      cursor < tokens.length && depth > 0;
      cursor++
    ) {
      const token = tokens[cursor];
      if (token.value === "{") depth++;
      if (token.value === "}") depth--;
      if (
        depth !== 1 ||
        token.value !== "name" ||
        tokens[cursor + 1]?.value !== ":"
      )
        continue;
      const name = tokens[cursor + 2];
      const following = tokens[cursor + 3];
      if (
        ++names !== 1 ||
        !name?.literal ||
        !APPLICATION_NAME.test(name.literal) ||
        (following?.value !== "}" &&
          !(
            following &&
            tokens[cursor + 4]?.value === ":" &&
            /[\r\n]/.test(source.slice(name.end, following.start))
          ))
      )
        return null;
      application = name.literal;
    }
    if (depth !== 0 || names !== 1) return null;
  }
  return resources === 1 ? application : null;
}

/** A declared title cannot authorize an arbitrary or multi-target command override. */
export function commandsMatchWorkflowApplication(
  commands: string,
  appFile: string,
  environment: string,
  application: string
): boolean {
  if (!commands.trim()) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(commands);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 2)
    return false;
  const [deploy, graph] = parsed;
  if (typeof deploy !== "string") return false;
  const args = deploy.trim().split(/\s+/);
  if (
    args[0] !== "deploy" ||
    args[1] !== appFile ||
    args[2] !== "--environment" ||
    args[3] !== environment
  )
    return false;
  for (let index = 4; index < args.length; index += 2) {
    if (
      args[index] !== "--parameters" ||
      !/^[A-Za-z_][A-Za-z0-9_]*=[^\s]+$/.test(args[index + 1] || "")
    )
      return false;
  }
  return (
    graph === undefined ||
    graph === `app graph ${application} -o json` ||
    graph === `app graph --application ${application} --include-icons`
  );
}

export function parseWorkflowApplicationTitle(
  title: string,
  environment: string,
  workflow: "deploy" | "delete"
): { application: string | null; correlationId: string } | null {
  if (title.length > 256) return null;
  const match =
    / \[radius:v1 app=([a-zA-Z][a-zA-Z0-9-]{0,62}|unknown)\] (dep-[a-zA-Z0-9-]{1,64})$/.exec(
      title
    );
  if (
    !match ||
    title.slice(0, match.index) !==
      `Radius - ${workflow === "deploy" ? "Deploy" : "Delete"} ${environment}`
  )
    return null;
  return {
    application: match[1] === "unknown" ? null : match[1],
    correlationId: match[2]
  };
}
