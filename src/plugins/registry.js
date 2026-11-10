// The plugin registry.
//
// A plugin is one of two things, and both end up behind the same interface:
//
//   JSON  — { id, name, category, params, graph }        interpreted by graph.js
//   JS    — { id, name, category, params, create(ctx, offline) }
//
// `create` returns { input, output, update(params), dispose?, tick?, readout? },
// which is the contract the mixer, the inspector, the live engine and the
// offline bounce have all spoken since before there was a registry.
//
// Ids are namespaced ("core.eq", "tape.wobble") so a plugin someone hands you
// cannot quietly shadow a built-in. Projects saved before namespacing used bare
// type names, so ALIASES maps those forward on load.

import { uid } from "../util.js";
import { registerWorklets, contextReady } from "./worklets.js";
import { compileGraph, instantiate } from "./graph.js";
import { validateManifest } from "./schema.js";

const plugins = new Map();
const listeners = new Set();

/** Legacy bare type names → namespaced ids. Never remove an entry from this. */
const ALIASES = {
  eq: "core.eq",
  filter: "core.filter",
  comp: "core.comp",
  limiter: "core.limiter",
  gate: "core.gate",
  delay: "core.delay",
  reverb: "core.reverb",
  chorus: "core.chorus",
  drive: "core.drive",
  width: "core.width",
  gain: "core.gain",
};

export const resolveId = (type) => (plugins.has(type) ? type : (ALIASES[type] ?? type));

export function onPluginsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((f) => f());

/**
 * Register a plugin. JSON manifests are validated and compiled here, so a bad
 * one throws at registration with every problem listed rather than failing at
 * the first knob move.
 *
 * `source` is bookkeeping for the manager UI: builtin | bundled | user.
 */
export function registerPlugin(spec, source = "user") {
  if (!spec || typeof spec !== "object") throw new Error("plugin must be an object");
  const isJson = !!spec.graph;
  if (!isJson && typeof spec.create !== "function") {
    throw new Error(`plugin "${spec.id}" needs either a "graph" (JSON) or a "create" function (JS)`);
  }

  let entry;
  if (isJson) {
    const compiled = compileGraph(spec);
    entry = {
      id: spec.id,
      name: spec.name,
      category: spec.category ?? "Other",
      description: spec.description ?? "",
      params: spec.params,
      kind: "json",
      source,
      manifest: spec,
      rebuildOn: compiled.rebuildOn,
      warnings: compiled.warnings,
      create: (ctx, offline) => instantiate(ctx, compiled, offline),
    };
  } else {
    const report = validateManifest({ ...spec, graph: { nodes: {}, connect: [["in", "out"]] } });
    // A JS plugin has no graph to check, but its parameter block still drives
    // the inspector, so it gets the same scrutiny.
    const paramErrors = report.errors.filter((e) => e.startsWith("params") || e.startsWith('"params"') || e.startsWith('"id"') || e.startsWith('"name"'));
    if (paramErrors.length) throw new Error(`plugin "${spec.id}" is invalid:\n  - ${paramErrors.join("\n  - ")}`);
    entry = {
      id: spec.id,
      name: spec.name,
      category: spec.category ?? "Other",
      description: spec.description ?? "",
      params: spec.params,
      kind: "js",
      source,
      rebuildOn: spec.rebuildOn ?? [],
      warnings: [],
      create: spec.create,
      // AudioWorklet modules this plugin's processors live in; the host loads them.
      worklets: registerWorklets(spec.worklets),
    };
  }
  // Delay the plugin adds to the signal, in seconds: a number, or a function of
  // its parameters. The engine and the bounce compensate for it.
  entry.latency = spec.latency ?? 0;

  if (plugins.has(entry.id) && plugins.get(entry.id).source !== source) {
    throw new Error(`plugin id "${entry.id}" is already taken by a ${plugins.get(entry.id).source} plugin`);
  }
  plugins.set(entry.id, entry);
  notify();
  return entry;
}

export function unregisterPlugin(id) {
  const p = plugins.get(id);
  if (!p) return false;
  if (p.source !== "user") throw new Error(`"${id}" is a ${p.source} plugin and cannot be removed`);
  plugins.delete(id);
  notify();
  return true;
}

export const getPlugin = (type) => plugins.get(resolveId(type)) ?? null;
export const hasPlugin = (type) => plugins.has(resolveId(type));
export const allPlugins = () => [...plugins.values()];

/** Plugins grouped for the add-insert menu, categories in a stable order. */
export function pluginsByCategory() {
  const order = ["Dynamics", "EQ / Filter", "Modulation", "Delay / Reverb", "Distortion", "Stereo", "Utility", "Other"];
  const groups = new Map();
  for (const p of plugins.values()) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category).push(p);
  }
  const known = order.filter((c) => groups.has(c));
  const extra = [...groups.keys()].filter((c) => !order.includes(c)).sort();
  return [...known, ...extra].map((c) => [c, groups.get(c).sort((a, b) => a.name.localeCompare(b.name))]);
}

export function labelOf(type) {
  const p = getPlugin(type);
  return p ? p.name : `⚠ ${type}`;
}

export function paramsOf(type) {
  return getPlugin(type)?.params ?? [];
}

export function defaultParams(type) {
  const out = {};
  for (const p of paramsOf(type)) out[p.key] = p.def;
  return out;
}

export function newEffect(type) {
  return { id: uid("fx"), type: resolveId(type), on: true, params: defaultParams(type) };
}

/**
 * Chain-shape signature. The engine rebuilds a chain only when this changes,
 * so it must cover everything that alters graph *structure*: which plugins are
 * present, their order, their bypass state — and any parameter a plugin
 * declared as rewiring it (a JSON `when` clause, or a JS plugin's `rebuildOn`).
 */
export function signatureOf(fx) {
  return (fx ?? [])
    .map((f) => {
      const p = getPlugin(f.type);
      const shape = (p?.rebuildOn ?? []).map((k) => `${k}=${f.params?.[k]}`).join(",");
      return `${f.id}:${resolveId(f.type)}:${f.on !== false ? 1 : 0}:${shape}`;
    })
    .join("|");
}

/**
 * Instantiate one effect from its document definition.
 *
 * An unknown type yields a *passthrough* rather than nothing. Dropping it would
 * silently change the mix — and since the app autosaves every 20 seconds, the
 * loss would be written to disk before you noticed. Audio passes through
 * untouched and the definition keeps its parameters, so loading the missing
 * plugin later restores the effect exactly.
 */
export function createEffect(ctx, def, offline = false) {
  const plugin = getPlugin(def.type);
  if (!plugin) {
    const passthrough = ctx.createGain();
    return { input: passthrough, output: passthrough, id: def.id, type: def.type, missing: true, update() {} };
  }
  if (plugin.worklets?.length && !contextReady(ctx, plugin.worklets)) {
    // Its processor module is still loading. Pass audio through for now; the
    // engine rebuilds the chain as soon as the module is in. (A bounce awaits
    // the modules before it builds anything, so it never takes this branch.)
    const passthrough = ctx.createGain();
    return { input: passthrough, output: passthrough, id: def.id, type: def.type, pending: true, update() {} };
  }
  const fx = plugin.create(ctx, offline);
  fx.type = resolveId(def.type);
  fx.id = def.id;
  fx.plugin = plugin;
  fx.update({ ...defaultParams(def.type), ...def.params });
  return fx;
}

/** Seconds of delay one insert adds: 0 when bypassed or missing. */
export function latencyOf(def) {
  if (!def || def.on === false) return 0;
  const plugin = getPlugin(def.type);
  if (!plugin?.latency) return 0;
  const v = typeof plugin.latency === "function" ? plugin.latency({ ...defaultParams(def.type), ...def.params }) : plugin.latency;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Seconds of delay a whole insert chain adds. */
export const chainLatency = (fx) => (fx ?? []).reduce((sum, def) => sum + latencyOf(def), 0);

/** Ids in `fx` that have no registered plugin. */
export function missingPlugins(fx) {
  return [...new Set((fx ?? []).filter((f) => !hasPlugin(f.type)).map((f) => f.type))];
}

/** Every missing plugin id referenced anywhere in a project. */
export function missingInProject(project) {
  const ids = new Set();
  for (const t of project.tracks ?? []) for (const id of missingPlugins(t.fx)) ids.add(id);
  for (const id of missingPlugins(project.master?.fx)) ids.add(id);
  return [...ids];
}

/**
 * Pool assets referenced by insert parameters (a cabinet's impulse response),
 * so the pool can show them as in use even though no clip plays them.
 */
export function fxAssetIds(project) {
  const ids = new Set();
  const scan = (fx) => {
    for (const f of fx ?? []) {
      for (const p of paramsOf(f.type)) if (p.asset && f.params?.[p.key]) ids.add(f.params[p.key]);
    }
  };
  for (const t of project.tracks ?? []) scan(t.fx);
  scan(project.master?.fx);
  return ids;
}
