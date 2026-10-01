import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import {
  hash,
  HEADLAMP_IMAGE,
  HEADLAMP_GRAPHVIEW_CSS,
  styleChanges,
  TOOL_VERSIONS,
  validateCardGeometry,
  validateBundledLayout,
  validateHostSample,
  validatePeerStyles,
  validateTarEntries,
  withoutCandidateStyles
} from "./contracts.mjs";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const expect = playwrightExpect.configure({ timeout: 10_000 });
const save = (path, data) =>
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);

function run(command, args, cwd, env, log) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  });
  writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} failed; ${log}:\n${`${result.stdout}\n${result.stderr}`.split("\n").slice(0, 25).join("\n")}`
  );
  return result.stdout;
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

async function peerStyles(page) {
  const controls = page.locator(
    ".headlamp-peer-flow .react-flow__controls-button"
  );
  await expect(controls).toHaveCount(4);
  return controls.evaluateAll((buttons) =>
    buttons.map((button) => {
      const css = globalThis.getComputedStyle(button);
      return Object.fromEntries(
        [
          "width",
          "height",
          "padding",
          "border",
          "boxSizing",
          "backgroundColor",
          "color",
          "borderRadius",
          "fontSize"
        ].map((key) => [key, css[key]])
      );
    })
  );
}

async function cards(graph) {
  return graph.locator('[data-radius-part="node"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        cssWidth: globalThis.getComputedStyle(node).width,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height
      };
    })
  );
}

async function samplePeer(page) {
  return page.locator(".headlamp-peer-flow").evaluate((root) => {
    const selectors = [
      ".react-flow",
      ".react-flow__node",
      ".react-flow__handle",
      ".react-flow__edge-path",
      ".react-flow__controls",
      ".react-flow__controls-button",
      ".react-flow__controls-button svg"
    ];
    const properties = [
      "width",
      "height",
      "padding",
      "margin",
      "border",
      "box-sizing",
      "background-color",
      "color",
      "border-radius",
      "box-shadow",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "animation-name",
      "animation-duration",
      "z-index",
      "pointer-events",
      "position",
      "fill",
      "stroke",
      "stroke-width",
      "max-width",
      "max-height"
    ];
    return Object.fromEntries(
      selectors.map((selector) => [
        selector,
        Array.from(root.querySelectorAll(selector)).map((element) => {
          const css = globalThis.getComputedStyle(element);
          return Object.fromEntries(
            properties.map((property) => [
              property,
              css.getPropertyValue(property)
            ])
          );
        })
      ])
    );
  });
}

async function auditCssOrder(page, output, order) {
  const before = await samplePeer(page);
  assert.equal(
    before[".react-flow__node"][0].position,
    "absolute",
    "The Flow 12 baseline must load its own real vendor stylesheet"
  );
  assert.equal(before[".react-flow__node"][0].width, "150px");
  const results = { before, stages: [] };
  let previous = before;
  for (const stage of order) {
    const button =
      stage === "headlamp" ?
        "Load Headlamp GraphView stylesheet"
      : "Load candidate stylesheet";
    const suffix =
      stage === "headlamp" ? HEADLAMP_GRAPHVIEW_CSS : "candidate-styles.css";
    await page.getByRole("button", { name: button }).click();
    await page.waitForFunction(
      (name) =>
        Array.from(globalThis.document.styleSheets).some((sheet) =>
          sheet.href?.endsWith(`/${name}`)
        ),
      suffix
    );
    const computed = await samplePeer(page);
    const changes = styleChanges(previous, computed);
    await page.locator(".headlamp-peer-flow .react-flow__node").first().hover();
    const hovered = await samplePeer(page);
    await page
      .getByRole("heading", { name: "Radius graph in Headlamp" })
      .hover();
    results.stages.push({ stage, computed, changes, hovered });
    previous = computed;
  }
  const name = order.join("-then-");
  save(join(output, `css-${name}.json`), results);
  await page.screenshot({
    path: join(output, `css-${name}.png`),
    fullPage: true,
    timeout: 30_000
  });
  return results;
}

async function exerciseCandidate(page) {
  await expect(
    page.getByRole("status", { name: "Host React version" })
  ).toHaveText("18.3.1");
  await expect(page.getByRole("status", { name: "Host MUI mode" })).toHaveText(
    /light|dark/
  );
  const graph = page.getByRole("region", {
    name: "Application graph",
    exact: true
  });
  await expect(graph.locator('[data-radius-part="node"]')).toHaveCount(2);
  validateCardGeometry(await cards(graph));
  const web = graph.getByRole("group", { name: "web", exact: true });
  await expect(web).toHaveAttribute("data-radius-provisioning", "Succeeded");
  await expect(web.getByLabel("Provisioning status: Succeeded")).toBeVisible();
  await expect(web.locator('[data-radius-part="source"]')).toHaveCount(0);
  const edge = graph.locator(".radius-graph__edge .react-flow__edge-path");
  await expect(edge).toHaveCount(1);
  const geometry = await edge.evaluate((path) => ({
    d: path.getAttribute("d"),
    length: path.getTotalLength()
  }));
  assert.ok(
    geometry.d &&
      !/NaN|Infinity/.test(geometry.d) &&
      Number.isFinite(geometry.length) &&
      geometry.length > 0
  );
  const details = web.getByRole("button", { name: "Show details" });
  await details.focus();
  await page.keyboard.press("Enter");
  const panel = graph.locator("[data-radius-details]");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Provisioning status: Succeeded");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(details).toBeFocused();
  await web.getByRole("button", { name: "Open web" }).click();
  await expect(
    page.getByRole("status", { name: "Graph navigation" })
  ).toHaveText(/containers\/web$/);
  const viewport = graph.locator(".react-flow__viewport");
  const previous = await viewport.getAttribute("style");
  await graph.getByRole("button", { name: "zoom in", exact: true }).click();
  await expect(viewport).not.toHaveAttribute("style", previous);

  const sourceGraph = page.getByRole("region", {
    name: "Modeled source graph"
  });
  const sourceNode = sourceGraph.getByRole("group", { name: "modeled-web" });
  await sourceNode.getByRole("button", { name: "Show details" }).focus();
  await page.keyboard.press("Enter");
  const sourcePanel = sourceGraph.locator("[data-radius-details]");
  await expect(sourcePanel).toBeVisible();
  const source = sourcePanel.getByRole("link", { name: "View source code" });
  await expect(source).toHaveAttribute(
    "href",
    "https://github.com/radius-project/offline-fixture/blob/main/src/web.ts"
  );
  const icon = source.locator("svg");
  await expect(icon).toHaveCSS("width", "14px");
  await expect(icon).toHaveCSS("height", "14px");
  await source.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status", { name: "Graph navigation" })
  ).toHaveText(
    "https://github.com/radius-project/offline-fixture/blob/main/src/web.ts"
  );
  await page.keyboard.press("Escape");
  await expect(
    sourceNode.getByRole("button", { name: "Show details" })
  ).toBeFocused();
  await page.getByRole("button", { name: "Toggle Radius graph" }).click();
  await expect(graph).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle Radius graph" }).click();
  await expect(graph.locator('[data-radius-part="node"]')).toHaveCount(2);
  await page.getByRole("link", { name: "Leave compatibility route" }).click();
  await expect(graph).toHaveCount(0);
  await page.getByRole("link", { name: "Reopen compatibility route" }).click();
  await expect(graph.locator('[data-radius-part="node"]')).toHaveCount(2);
  validateCardGeometry(await cards(graph));
}

async function hostScenario({
  variant,
  bundle,
  fixture,
  output,
  work,
  env,
  browser,
  baseline,
  auditCss = false
}) {
  const plugins = join(work, `plugins-${variant}`);
  const plugin = join(plugins, "radius-headlamp-consumer");
  mkdirSync(plugin, { recursive: true });
  cpSync(bundle, join(plugin, "main.js"));
  cpSync(join(fixture, "package.json"), join(plugin, "package.json"));
  if (auditCss || variant === "candidate") {
    cpSync(
      join(
        fixture,
        "node_modules",
        "@radius-project",
        "graph-react",
        "dist",
        "styles.css"
      ),
      join(plugin, "candidate-styles.css")
    );
  }
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const log = createWriteStream(join(output, `server-${variant}.log`));
  const server = spawn(
    "/headlamp/headlamp-server",
    [
      "-listen-addr",
      "127.0.0.1",
      "-port",
      String(port),
      "-html-static-dir",
      "/headlamp/frontend",
      "-plugins-dir",
      plugins,
      "-user-plugins-dir",
      join(work, "user-plugins"),
      "-kubeconfig",
      join(work, "empty-kubeconfig"),
      "-kubeconfig-dir",
      join(work, "kubeconfigs"),
      "-watch-plugins-changes=false"
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] }
  );
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    colorScheme: "light"
  });
  const requests = [];
  const errors = [];
  const consoleErrors = [];
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => requests.push(request.url()));
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ?
      route.continue()
    : route.abort()
  );
  try {
    await expect
      .poll(
        async () => {
          assert.equal(
            server.exitCode,
            null,
            "Headlamp server exited before readiness"
          );
          try {
            return (await fetch(origin)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 30_000 }
      )
      .toBe(200);
    await page.goto(`${origin}/radius-graph-compatibility`);
    await expect(
      page.getByRole("main", { name: "Radius Headlamp compatibility" })
    ).toBeVisible({ timeout: 30_000 });
    if (!auditCss) {
      await page.addStyleTag({
        url: `${origin}/assets/${HEADLAMP_GRAPHVIEW_CSS}`
      });
    }
    const peer = await peerStyles(page);
    save(join(output, `peer-${variant}.json`), peer);
    const sample = auditCss ? null : await samplePeer(page);
    if (sample) save(join(output, `peer-sample-${variant}.json`), sample);
    if (auditCss) {
      await expect(
        page.locator(".headlamp-peer-flow .react-flow__node")
      ).toHaveCount(2);
      await expect(
        page.locator(".headlamp-peer-flow .react-flow__edge-path")
      ).toHaveCount(1);
      const hostFirst = await auditCssOrder(page, output, [
        "headlamp",
        "radius"
      ]);
      await page.reload();
      await expect(
        page.getByRole("main", { name: "Radius Headlamp compatibility" })
      ).toBeVisible({ timeout: 30_000 });
      const radiusFirst = await auditCssOrder(page, output, [
        "radius",
        "headlamp"
      ]);
      const residual = styleChanges(
        hostFirst.stages[0].computed,
        radiusFirst.stages[1].computed
      );
      save(join(output, "css-radius-first-residual.json"), residual);
      console.log(
        `Radius after actual GraphView CSS: ${hostFirst.stages[1].changes.length} changes; Radius before GraphView: ${residual.length} residual changes.`
      );
    } else if (variant === "candidate") {
      validatePeerStyles(baseline.peer, peer);
      validateHostSample(baseline.sample, sample, "loaded with");
      await exerciseCandidate(page);
      await page.addStyleTag({
        url: `${origin}/plugins/radius-headlamp-consumer/candidate-styles.css`
      });
      const radiusLast = await peerStyles(page);
      save(join(output, "peer-candidate-radius-last.json"), radiusLast);
      validatePeerStyles(baseline.peer, radiusLast);
      const radiusLastSample = await samplePeer(page);
      save(
        join(output, "peer-sample-candidate-radius-last.json"),
        radiusLastSample
      );
      validateHostSample(baseline.sample, radiusLastSample, "loaded after");
      await exerciseCandidate(page);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      await expect(
        page.getByRole("main", { name: "Radius Headlamp compatibility" })
      ).toBeVisible({ timeout: 30_000 });
      await page.addStyleTag({
        url: `${origin}/assets/${HEADLAMP_GRAPHVIEW_CSS}`
      });
      await expect(
        page.getByRole("status", { name: "Host MUI mode" })
      ).toHaveText("dark");
      await exerciseCandidate(page);
    } else if (variant === "missing-css") {
      const graph = page.getByRole("region", {
        name: "Application graph",
        exact: true
      });
      await expect(graph.locator('[data-radius-part="node"]')).toHaveCount(2);
      const measured = await cards(graph);
      save(join(output, "missing-css-geometry.json"), measured);
      assert.throws(
        () => validateCardGeometry(measured),
        /220px graph card geometry/
      );
    }
    await page.screenshot({
      path: join(output, `${variant}.png`),
      fullPage: true,
      timeout: 30_000
    });
    assert.ok(
      requests.some((url) => /plugins.*main\.js/.test(url)),
      "The actual Headlamp loader must request the plugin"
    );
    for (const url of requests)
      assert.equal(
        new URL(url).origin,
        origin,
        `Unexpected external request: ${url}`
      );
    assert.deepEqual(
      errors,
      [],
      "The actual Headlamp page must not report JavaScript errors"
    );
    assert.deepEqual(
      consoleErrors.filter((message) =>
        /Plugin (?:execution|initialize\(\)) error/.test(message)
      ),
      [],
      "Headlamp must not catch and suppress a plugin initialization error"
    );
    assert.ok(requests.includes(`${origin}/assets/${HEADLAMP_GRAPHVIEW_CSS}`));
    return { peer, sample };
  } catch (error) {
    try {
      await page.screenshot({
        path: join(output, `${variant}-failure.png`),
        fullPage: true,
        timeout: 30_000
      });
      writeFileSync(
        join(output, `${variant}-failure.html`),
        await page.content()
      );
    } catch (diagnosticError) {
      writeFileSync(
        join(output, `${variant}-diagnostic-error.log`),
        String(diagnosticError)
      );
    }
    throw error;
  } finally {
    save(join(output, `browser-${variant}.json`), {
      requests,
      errors,
      consoleErrors
    });
    await context.tracing.stop({ path: join(output, `${variant}-trace.zip`) });
    await context.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([
        once(server, "exit"),
        setTimeout(5_000).then(() => {
          if (server.exitCode === null) server.kill("SIGKILL");
        })
      ]);
    }
    log.end();
  }
}

async function qualify(root, seeds, output, { auditCss = false } = {}) {
  assert.ok(output, "An artifact output directory is required");
  mkdirSync(output, { recursive: true });
  const work = join(root, ".artifacts", `headlamp-runtime-${randomUUID()}`);
  mkdirSync(work, { recursive: true });
  const savedCandidates = join(output, "candidates");
  mkdirSync(savedCandidates, { recursive: true });
  const fixture = join(root, "scripts", "fixtures", "headlamp");
  const env = {
    PATH: process.env.PATH,
    CI: "1",
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    HOME: work,
    XDG_CONFIG_HOME: join(work, "config"),
    TMP: work,
    TEMP: work,
    TMPDIR: work,
    npm_config_offline: "true",
    npm_config_registry: "http://127.0.0.1:9",
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: join(work, "empty.npmrc"),
    npm_config_globalconfig: join(work, "empty-global.npmrc")
  };
  writeFileSync(env.npm_config_userconfig, "");
  writeFileSync(env.npm_config_globalconfig, "");
  writeFileSync(
    join(work, "empty-kubeconfig"),
    'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\ncurrent-context: ""\n'
  );
  const require = createRequire(join(fixture, "package.json"));
  const versions = Object.fromEntries(
    Object.keys(TOOL_VERSIONS).map((name) => [
      name,
      json(join(fixture, "node_modules", name, "package.json")).version
    ])
  );
  assert.deepEqual(versions, TOOL_VERSIONS);
  const tool = dirname(
    require.resolve("@kinvolk/headlamp-plugin/package.json")
  );
  const configs = ["plugins-tsconfig.json", "vite.config.mjs"];
  const configHashes = Object.fromEntries(
    configs.map((name) => [
      name,
      hash(readFileSync(join(tool, "config", name)))
    ])
  );
  let candidates = seeds;
  const receipt = {
    hostImage: HEADLAMP_IMAGE,
    node: process.version,
    versions,
    configHashes,
    resolvedLockSha256: hash(readFileSync(join(fixture, "package-lock.json"))),
    serverSha256: hash(readFileSync("/headlamp/headlamp-server")),
    frontendIndexSha256: hash(readFileSync("/headlamp/frontend/index.html")),
    graphViewCss: {
      file: HEADLAMP_GRAPHVIEW_CSS,
      sha256: hash(
        readFileSync(join("/headlamp/frontend/assets", HEADLAMP_GRAPHVIEW_CSS))
      )
    },
    offline: true,
    scope: auditCss ? "outgoing-css-audit-only" : "full-compatibility",
    result: "in_progress",
    candidateTarballs: {}
  };
  cpSync(
    join(fixture, "package-lock.json"),
    join(output, "resolved-package-lock.json")
  );
  save(join(output, "receipt.json"), receipt);
  if (!candidates) {
    candidates = join(work, "candidates");
    mkdirSync(candidates);
    run(
      process.execPath,
      ["scripts/build-libraries.mjs"],
      root,
      env,
      join(output, "library-build.log")
    );
    for (const name of ["core", "graph-react"]) {
      run(
        "pnpm",
        ["pack", "--pack-destination", candidates],
        join(root, "packages", name),
        env,
        join(output, `pack-${name}.log`)
      );
    }
  }
  for (const name of ["core", "graph-react"]) {
    const files = readdirSync(candidates).filter(
      (file) =>
        file.startsWith(`radius-project-${name}-`) && file.endsWith(".tgz")
    );
    assert.equal(files.length, 1, `Expected one ${name} candidate`);
    const tarball = join(candidates, files[0]);
    cpSync(tarball, join(savedCandidates, files[0]));
    receipt.candidateTarballs[name] = {
      file: files[0],
      sha256: hash(readFileSync(tarball))
    };
    const tar = require("tar");
    const entries = [];
    const types = [];
    await tar.t({
      file: tarball,
      onReadEntry: (entry) => {
        entries.push(entry.path);
        types.push(entry.type);
      }
    });
    validateTarEntries(entries, types);
    save(join(output, `tar-${name}.json`), { entries, types });
    const installed = join(fixture, "node_modules", "@radius-project", name);
    rmSync(installed, { recursive: true, force: true });
    mkdirSync(installed, { recursive: true });
    run(
      "tar",
      [
        "-xzf",
        tarball,
        "--strip-components=1",
        "-C",
        installed,
        "--no-same-owner"
      ],
      root,
      env,
      join(output, `extract-${name}.log`)
    );
    assert.equal(lstatSync(installed).isSymbolicLink(), false);
    assert.equal(realpathSync(installed), installed);
    assert.equal(existsSync(join(installed, "src")), false);
  }
  const core = json(
    join(fixture, "node_modules", "@radius-project", "core", "package.json")
  );
  const graph = json(
    join(
      fixture,
      "node_modules",
      "@radius-project",
      "graph-react",
      "package.json"
    )
  );
  assert.equal(graph.dependencies["@radius-project/core"], core.version);
  const graphRequire = createRequire(
    join(
      fixture,
      "node_modules",
      "@radius-project",
      "graph-react",
      "package.json"
    )
  );
  for (const name of ["react", "react-dom", "@radius-project/core/graph"])
    assert.equal(graphRequire.resolve(name), require.resolve(name));
  validateBundledLayout(graphRequire.resolve, graph.dependencies);
  save(join(output, "receipt.json"), receipt);
  const index = join(fixture, "src", "index.tsx");
  const original = readFileSync(index, "utf8");
  const baselineSource = readFileSync(
    join(fixture, "src", "baseline.tsx"),
    "utf8"
  );
  if (auditCss) writeFileSync(index, baselineSource);
  let typecheck;
  try {
    typecheck = run(
      process.execPath,
      [require.resolve("typescript/bin/tsc"), "--noEmit", "--listFiles"],
      fixture,
      env,
      join(output, "plugin-typecheck.log")
    );
  } finally {
    writeFileSync(index, original);
  }
  for (const path of typecheck.trim().split("\n")) {
    assert.ok(
      path.startsWith(`${fixture}/`),
      `Workspace declarations leaked into Headlamp plugin: ${path}`
    );
  }
  const bundles = {};
  try {
    for (const [variant, source] of auditCss ?
      [["baseline", baselineSource]]
    : [
        ["baseline", baselineSource],
        ["missing-css", withoutCandidateStyles(original)],
        ["candidate", original]
      ]) {
      writeFileSync(index, source);
      run(
        process.execPath,
        [join(tool, "bin", "headlamp-plugin.js"), "build"],
        fixture,
        env,
        join(output, `plugin-build-${variant}.log`)
      );
      const bundle = join(output, `${variant}-main.js`);
      cpSync(join(fixture, "dist", "main.js"), bundle);
      bundles[variant] = bundle;
    }
  } finally {
    writeFileSync(index, original);
  }
  for (const name of configs)
    assert.equal(
      hash(readFileSync(join(tool, "config", name))),
      configHashes[name]
    );
  const browser = await chromium.launch({ headless: true, env });
  receipt.chromium = browser.version();
  try {
    const args = { fixture, output, work, env, browser };
    const baseline = await hostScenario({
      ...args,
      variant: "baseline",
      bundle: bundles.baseline,
      auditCss
    });
    if (!auditCss) {
      await hostScenario({
        ...args,
        variant: "missing-css",
        bundle: bundles["missing-css"]
      });
      await hostScenario({
        ...args,
        variant: "candidate",
        bundle: bundles.candidate,
        baseline
      });
    }
    receipt.result = auditCss ? "measured" : "passed";
    receipt.actualHeadlampLoader = true;
  } finally {
    await browser.close();
    save(join(output, "receipt.json"), receipt);
  }
  if (!auditCss)
    console.log(
      `Headlamp ${HEADLAMP_IMAGE}: plugin build, real host, Flow 12 isolation, keyboard, source links, theme, navigation, teardown, and missing-CSS negative control passed.`
    );
}

export async function qualifyHeadlamp(root, seeds, output, options) {
  try {
    await qualify(root, seeds, output, options);
  } catch (error) {
    const path = join(output, "receipt.json");
    const receipt = existsSync(path) ? json(path) : {};
    save(path, { ...receipt, result: "failed", failure: String(error) });
    throw error;
  }
}
