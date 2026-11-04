// AWS environments stay hidden from users until they ship. A developer turns
// them on by starting the extension with RADIUS_CANVAS_AWS=1; the composition
// root reads the switch once and injects it.
export const AWS_SWITCH_VARIABLE = "RADIUS_CANVAS_AWS";

export function readAwsSwitch(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  return environment[AWS_SWITCH_VARIABLE] === "1";
}
