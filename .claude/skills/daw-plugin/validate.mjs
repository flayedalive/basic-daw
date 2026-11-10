#!/usr/bin/env node
// Validate a DAW plugin manifest against the app's own rules.
//
//   node validate.mjs my-plugin.json            check the manifest
//   node validate.mjs my-plugin.json --build    also build it and sweep every parameter
//   node validate.mjs src/plugins/bundled/*.json --build
//
// This imports src/plugins/schema.js directly rather than reimplementing it, so
// it cannot drift from what the installer accepts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const SRC = resolve(ROOT, "src/plugins");

const args = process.argv.slice(2);
const build = args.includes("--build");
const files = args.filter((a) => !a.startsWith("--"));

if (!files.length) {
  console.error("usage: node validate.mjs <manifest.json> [more.json …] [--build]");
  process.exit(2);
}

const { validateManifest } = await import(resolve(SRC, "schema.js"));

let graph = null;
if (build) {
  const { installDomStubs } = await import(resolve(HERE, "mock-audio.mjs"));
  installDomStubs();
  graph = await import(resolve(SRC, "graph.js"));
}

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let failed = 0;

for (const file of files) {
  console.log(`\n${file}`);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`  ${red("✗ not valid JSON")} — ${err.message}`);
    failed++;
    continue;
  }

  const list = Array.isArray(manifest) ? manifest : [manifest];
  for (const m of list) {
    const label = list.length > 1 ? `  ${m?.id ?? "?"}` : "";
    if (label) console.log(label);

    const report = validateManifest(m);
    for (const e of report.errors) console.log(`  ${red("✗")} ${e}`);
    for (const w of report.warnings) console.log(`  ${yellow("!")} ${w}`);

    if (!report.ok) {
      failed++;
      continue;
    }

    const notes = [
      `${m.params.length} param${m.params.length === 1 ? "" : "s"}`,
      `${Object.keys(m.graph.nodes).length} nodes`,
      m.category ?? "Other",
      report.rebuildOn.length ? `rewires on: ${report.rebuildOn.join(", ")}` : null,
    ].filter(Boolean);
    console.log(`  ${green("✓ valid")} ${dim(notes.join(" · "))}`);

    if (!build) continue;

    try {
      const { MockAudioContext } = await import(resolve(HERE, "mock-audio.mjs"));
      const compiled = graph.compileGraph(m);
      const ctx = new MockAudioContext();
      const fx = graph.instantiate(ctx, compiled, false);
      const defaults = Object.fromEntries(m.params.map((p) => [p.key, p.def]));
      fx.update(defaults);

      // Sweep every parameter to its extremes. Curves, IRs and `when` clauses
      // only misbehave at the edges of their ranges.
      let updates = 1;
      for (const p of m.params) {
        const values = p.choices ? p.choices : p.bool ? [true, false, true] : [p.min, (p.min + p.max) / 2, p.max];
        for (const v of values) {
          fx.update({ ...defaults, [p.key]: v });
          updates++;
        }
      }
      fx.update(defaults);

      for (const [name, def] of Object.entries(m.graph.nodes)) {
        const node = fx.nodes.get(name);
        if (def.curve && !(node.curve instanceof Float32Array)) throw new Error(`node "${name}": curve was never generated`);
        if (def.ir && !node.buffer) throw new Error(`node "${name}": impulse response was never generated`);
        // A curve that maps silence to something else puts DC on the output the
        // moment the graph exists. Live, that settles long before you press
        // play; a bounce starts cold, so it opens with a click playback never had.
        if (def.curve) {
          const c = node.curve;
          const mid = c.length % 2 ? c[(c.length - 1) / 2] : (c[c.length / 2 - 1] + c[c.length / 2]) / 2;
          if (Math.abs(mid) > 1e-3) console.log(`  ${yellow("!")} node "${name}": curve maps silence to ${mid.toFixed(3)}, not 0 — a bounce will start with a click (see docs/plugins.md, Curve recipes)`);
        }
      }

      // A second instance in "offline" mode must reach the same values, or a
      // bounce will not match playback.
      const off = graph.instantiate(new MockAudioContext(), compiled, true);
      off.update(defaults);
      for (const [name] of Object.entries(m.graph.nodes)) {
        const a = fx.nodes.get(name);
        const b = off.nodes.get(name);
        for (const key of Object.keys(a)) {
          if (a[key]?.constructor?.name !== "Param") continue;
          if (a[key].value !== b[key].value) {
            throw new Error(`node "${name}".${key} differs live vs offline (${a[key].value} vs ${b[key].value}) — a bounce would not match playback`);
          }
        }
      }

      fx.dispose();
      console.log(`  ${green("✓ builds")} ${dim(`${updates} parameter updates, live and offline agree`)}`);
    } catch (err) {
      console.log(`  ${red("✗ failed to build")} — ${err.message}`);
      failed++;
    }
  }
}

console.log(failed ? `\n${red(`${failed} problem${failed === 1 ? "" : "s"}`)}` : `\n${green("all good")}`);
process.exit(failed ? 1 : 0);
