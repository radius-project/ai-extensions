/**
 * Check JSON grammar without constructing a value or throwing for malformed
 * candidates. Callers can reserve JSON.parse for syntactically valid input.
 */
export function validJsonSyntax(
  text: string,
  start: number,
  end: number
): boolean {
  type Context = {
    kind: "array" | "object";
    state: "first" | "required" | "next" | "colon" | "value";
  };
  const stack: Context[] = [];
  let index = start;
  const digit = (code: number) => code >= 48 && code <= 57;
  const space = () =>
    text[index] === " " ||
    text[index] === "\t" ||
    text[index] === "\r" ||
    text[index] === "\n";
  const skipSpace = () => {
    while (index < end && space()) index++;
  };
  const readString = (): boolean => {
    if (text[index++] !== '"') return false;
    while (index < end) {
      const code = text.charCodeAt(index++);
      if (code === 34) return true;
      if (code < 32) return false;
      if (code !== 92) continue;
      const escape = text[index++];
      if (escape === undefined) return false;
      if (escape === "u") {
        for (let count = 0; count < 4; count++) {
          const hex = text.charCodeAt(index++);
          if (
            !digit(hex) &&
            !(hex >= 65 && hex <= 70) &&
            !(hex >= 97 && hex <= 102)
          )
            return false;
        }
      } else if (!'"\\/bfnrt'.includes(escape)) {
        return false;
      }
    }
    return false;
  };
  const readValue = (): boolean => {
    const character = text[index];
    if (character === "{" || character === "[") {
      stack.push({
        kind: character === "{" ? "object" : "array",
        state: "first"
      });
      index++;
      return true;
    }
    if (character === '"') return readString();
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index) && index + literal.length <= end) {
        index += literal.length;
        return true;
      }
    }
    if (character === "-") index++;
    const first = text.charCodeAt(index);
    if (first === 48) {
      index++;
    } else if (first >= 49 && first <= 57) {
      do {
        index++;
      } while (index < end && digit(text.charCodeAt(index)));
    } else {
      return false;
    }
    if (text[index] === ".") {
      index++;
      if (!digit(text.charCodeAt(index))) return false;
      do {
        index++;
      } while (index < end && digit(text.charCodeAt(index)));
    }
    if (text[index] === "e" || text[index] === "E") {
      index++;
      if (text[index] === "+" || text[index] === "-") index++;
      if (!digit(text.charCodeAt(index))) return false;
      do {
        index++;
      } while (index < end && digit(text.charCodeAt(index)));
    }
    return true;
  };
  skipSpace();
  if (!readValue()) return false;
  while (stack.length > 0) {
    skipSpace();
    const context = stack.at(-1)!;
    const character = text[index];
    if (context.kind === "array") {
      if (character === "]" && context.state !== "required") {
        stack.pop();
        index++;
      } else if (context.state === "next") {
        if (character !== ",") return false;
        context.state = "required";
        index++;
      } else {
        context.state = "next";
        if (!readValue()) return false;
      }
    } else if (character === "}" && context.state === "first") {
      stack.pop();
      index++;
    } else if (context.state === "first" || context.state === "required") {
      if (!readString()) return false;
      context.state = "colon";
    } else if (context.state === "colon") {
      if (character !== ":") return false;
      context.state = "value";
      index++;
    } else if (context.state === "value") {
      context.state = "next";
      if (!readValue()) return false;
    } else if (character === "}") {
      stack.pop();
      index++;
    } else {
      if (character !== ",") return false;
      context.state = "required";
      index++;
    }
  }
  skipSpace();
  return index === end;
}
