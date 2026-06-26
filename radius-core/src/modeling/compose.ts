// docker-compose service parsing — pure, used by app.bicep generation from a
// repository's compose file.

export function parseComposeServices(content: string): any[] {
  const services: any[] = [];
  const lines = content.split("\n");
  let inServices = false;
  let currentService: any = null;
  let serviceIndent = -1; // indent of "services:" key
  let svcNameIndent = -1; // indent of the first service name (locked after first match)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - trimmed.length;

    // Detect services: block
    if (!inServices) {
      if (/^services\s*:/.test(trimmed)) {
        inServices = true;
        serviceIndent = indent;
      }
      continue;
    }

    // Top-level key at same or lower indent as "services:" means we've left
    if (indent <= serviceIndent && trimmed && !trimmed.startsWith("#")) {
      if (currentService) services.push(currentService);
      break;
    }

    // Service name detection: must be at exactly one indent level below "services:"
    // Lock svcNameIndent to the first key we see after entering services block
    if (svcNameIndent === -1 && indent > serviceIndent && /^\w[\w-]*\s*:/.test(trimmed)) {
      svcNameIndent = indent;
    }

    if (indent === svcNameIndent && /^\w[\w-]*\s*:/.test(trimmed) && !trimmed.startsWith("-")) {
      if (currentService) services.push(currentService);
      const name = trimmed.split(":")[0].trim();
      currentService = { name, port: 3000, image: "", hasDockerfile: false, dependsOnDb: false };
      continue;
    }

    if (!currentService) continue;

    // Parse service properties (deeper indent than service name)
    if (indent <= svcNameIndent) continue;

    if (/^\s*image\s*:/.test(line)) {
      currentService.image = trimmed.replace(/^image\s*:\s*/, "").trim().replace(/['"]/g, "");
    }
    if (/^\s*build\s*:/.test(line)) {
      currentService.hasDockerfile = true;
    }
    // Extract first port
    if (/^\s*-\s*['"]?\d+:\d+/.test(line)) {
      const portMatch = trimmed.match(/-\s*['"]?(\d+):(\d+)/);
      if (portMatch) currentService.port = parseInt(portMatch[2]);
    }
    // Check depends_on for database
    if (/^\s*-\s*(database|db|mysql|postgres|redis)/i.test(line)) {
      currentService.dependsOnDb = true;
    }
    if (/DATABASE_TCP_HOST|MYSQL_HOST|POSTGRES_HOST|DB_HOST/i.test(line)) {
      currentService.dependsOnDb = true;
    }
  }
  if (currentService) services.push(currentService);
  return services;
}
