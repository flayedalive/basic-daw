// The JSON plugin manifest: its vocabulary, and a validator for it.
//
// NODE_TYPES is the single source of truth — `graph.js` builds from the same
// table this file validates against, so a node kind can never be accepted by
// the validator and then fail to build (or vice versa).
//
// Nothing in this module touches the DOM or Web Audio, so it runs unchanged
// under Node. That is what lets the authoring skill's `validate.mjs` check a
// manifest with exactly the rules the app will apply.

import { compileExpr } from "./expr.js";

/* ── node vocabulary ──────────────────────────────────────────────────── */

/** Channel-routing options every node accepts. */
export const COMMON_OPTS = {
  channelCount: "number",
  channelCountMode: ["max", "clamped-max", "explicit"],
  channelInterpretation: ["speakers", "discrete"],
};

/**
 * `audioParams` are k-rate/a-rate AudioParams: bindable, and legal as the
 * destination of a `connect` (that is how you modulate one node with another).
 *
 * `props` are plain JS properties, set instantly on update. They are keyed by
 * the name a manifest uses, which is deliberately *not* always the Web Audio
 * property name: a node's kind already occupies `type`, so BiquadFilterNode's
 * `type` is spelled `filter` and OscillatorNode's is spelled `wave`.
 */
export const NODE_TYPES = {
  gain: { audioParams: ["gain"], props: {}, opts: {}, desc: "Volume. The universal glue node." },
  delay: {
    audioParams: ["delayTime"],
    props: {},
    opts: { maxDelay: "number" },
    desc: "Delay line. `maxDelay` (seconds, default 1) caps delayTime and cannot be changed later.",
  },
  biquad: {
    audioParams: ["frequency", "Q", "gain", "detune"],
    props: {
      filter: {
        prop: "type",
        values: ["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"],
      },
    },
    opts: {},
    desc: 'Biquad filter. Set `filter` to the response shape, or bind it to a choice parameter.',
  },
  osc: {
    audioParams: ["frequency", "detune"],
    props: { wave: { prop: "type", values: ["sine", "square", "sawtooth", "triangle"] } },
    opts: { start: "boolean" },
    desc: "Oscillator. Starts at time 0 unless `start: false`. Use it as an LFO by connecting it to an AudioParam.",
  },
  constant: {
    audioParams: ["offset"],
    props: {},
    opts: { start: "boolean" },
    desc: "Constant signal. Useful for offsetting a modulated AudioParam.",
  },
  shaper: {
    audioParams: [],
    props: { oversample: { prop: "oversample", values: ["none", "2x", "4x"] } },
    opts: { curve: "curve" },
    desc: "Waveshaper. `curve` takes a recipe (see CURVE_KINDS); output is clamped to [-1, 1].",
  },
  convolver: {
    audioParams: [],
    props: {},
    opts: { ir: "ir", normalize: "boolean" },
    desc: "Convolution. `ir` takes an impulse-response recipe (see IR_KINDS).",
  },
  compressor: {
    audioParams: ["threshold", "knee", "ratio", "attack", "release"],
    props: {},
    opts: {},
    desc: "Dynamics compressor. Exposes gain reduction as the plugin's readout.",
  },
  panner: { audioParams: ["pan"], props: {}, opts: {}, desc: "Stereo panner, -1 (left) to 1 (right)." },
  splitter: {
    audioParams: [],
    props: {},
    opts: { channels: "number" },
    desc: "Channel splitter. Address its outputs as `name[0]`, `name[1]`, …",
  },
  merger: {
    audioParams: [],
    props: {},
    opts: { channels: "number" },
    desc: "Channel merger. Address its inputs as `name[0]`, `name[1]`, …",
  },
  analyser: { audioParams: [], props: {}, opts: { fftSize: "number" }, desc: "Analyser tap. Does not alter the signal." },
};

export const CURVE_KINDS = {
  tanh: { fields: { amount: "value" }, desc: "Symmetric soft saturation. `amount` ≥ 1; higher is dirtier." },
  softclip: { fields: { knee: "value" }, desc: "Linear below `knee` (0–1), tanh bend above it. Bounded, so it is a true ceiling." },
  hardclip: { fields: { threshold: "value" }, desc: "Flat clip at ±`threshold`." },
  bitcrush: { fields: { bits: "value" }, desc: "Quantise to `bits` steps. Aliases hard — pair with oversample." },
  fold: { fields: { amount: "value" }, desc: "Wavefolder: reflects rather than clips. Very bright." },
  expr: { fields: { expr: "expr" }, desc: "Arbitrary shape. `x` runs -1 → 1; parameters are in scope." },
  table: { fields: { points: "points" }, desc: "Linear interpolation through [[x, y], …] with x ascending in [-1, 1]." },
};

export const IR_KINDS = {
  "noise-decay": {
    fields: { seconds: "value", decay: "value", damp: "value" },
    desc: "Exponentially decaying filtered noise — a plain room.",
  },
  impulse: { fields: {}, desc: "A single unit sample. A no-op reverb; useful as a wet/dry reference." },
  expr: {
    fields: { seconds: "value", expr: "expr" },
    desc: "Custom IR. `t` runs 0 → 1 across the tail, `noise` is fresh white noise per sample.",
  },
};

export const PARAM_FIELDS = ["key", "label", "min", "max", "def", "unit", "log", "prec", "choices", "bool", "asset", "hint"];

/* ── validation ───────────────────────────────────────────────────────── */

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split a `connect` endpoint into {node, index, param}. */
export function parseEndpoint(str) {
  if (typeof str !== "string") return { error: "endpoint must be a string" };
  let m = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]$/.exec(str);
  if (m) return { node: m[1], index: Number(m[2]) };
  m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(str);
  if (m) return { node: m[1], param: m[2] };
  if (NAME_RE.test(str)) return { node: str, index: 0 };
  return { error: `malformed endpoint "${str}"` };
}

/**
 * Validate a manifest. Returns { ok, errors, warnings, rebuildOn }.
 * `rebuildOn` lists the parameter keys that appear in a `when` clause — the
 * engine has to rebuild the chain when one of those changes, because they
 * alter the shape of the graph rather than a value inside it.
 */
export function validateManifest(m) {
  const errors = [];
  const warnings = [];
  const rebuildOn = new Set();
  const E = (msg) => errors.push(msg);

  if (!isObj(m)) return { ok: false, errors: ["manifest must be a JSON object"], warnings, rebuildOn: [] };

  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    E(`"id" must be a namespaced string like "myPack.wobble" (got ${JSON.stringify(m.id)})`);
  }
  if (typeof m.name !== "string" || !m.name.trim()) E(`"name" must be a non-empty display string`);
  if (m.category != null && typeof m.category !== "string") E(`"category" must be a string`);

  /* parameters */
  const params = Array.isArray(m.params) ? m.params : [];
  if (!Array.isArray(m.params)) E(`"params" must be an array (use [] for a plugin with no controls)`);
  const keys = new Set();
  for (const [i, p] of params.entries()) {
    const at = `params[${i}]`;
    if (!isObj(p)) {
      E(`${at} must be an object`);
      continue;
    }
    if (typeof p.key !== "string" || !NAME_RE.test(p.key)) {
      E(`${at}.key must be an identifier (letters, digits, underscore; not starting with a digit)`);
      continue;
    }
    if (keys.has(p.key)) E(`${at}.key "${p.key}" is a duplicate`);
    keys.add(p.key);
    if (p.key === "x") E(`${at}.key cannot be "x" — that name is reserved for the bound value in map expressions`);
    if (typeof p.label !== "string" || !p.label) E(`${at}.label is required`);
    if (p.choices) {
      if (!Array.isArray(p.choices) || !p.choices.length) E(`${at}.choices must be a non-empty array`);
      else if (!p.choices.includes(p.def)) E(`${at}.def must be one of ${at}.choices`);
    } else if (p.bool) {
      if (typeof p.def !== "boolean") E(`${at}.def must be true or false for a bool parameter`);
    } else if (p.asset) {
      // The value is the id of a pool file; a plugin cannot know one in advance.
      if (p.def !== "") E(`${at}.def must be "" for an asset parameter (none selected)`);
    } else {
      for (const f of ["min", "max", "def"]) {
        if (typeof p[f] !== "number" || !Number.isFinite(p[f])) E(`${at}.${f} must be a finite number`);
      }
      if (typeof p.min === "number" && typeof p.max === "number" && p.min >= p.max) E(`${at}.min must be below ${at}.max`);
      if (typeof p.def === "number" && p.def < p.min) E(`${at}.def is below ${at}.min`);
      if (typeof p.def === "number" && p.def > p.max) E(`${at}.def is above ${at}.max`);
      if (p.log && p.min <= 0) E(`${at}.log requires a positive min (logarithmic scaling cannot cross zero)`);
    }
    for (const f of Object.keys(p)) if (!PARAM_FIELDS.includes(f)) warnings.push(`${at}.${f} is not a recognised field`);
  }
  const names = [...keys];
  const scope = [...names, "x"];

  /** `extra` names are the variables a particular position adds — an IR
      expression is evaluated per sample with `t` and `noise` in scope. */
  const exprWith = (extra) => (src, at) => {
    try {
      compileExpr(src, [...scope, ...extra]);
      return true;
    } catch (err) {
      E(`${at}: ${err.message}`);
      return false;
    }
  };
  const expr = exprWith([]);
  const value = (v, at) => (typeof v === "number" ? true : expr(v, at));

  /* graph */
  const g = m.graph;
  if (!isObj(g)) {
    E(`"graph" must be an object with "nodes" and "connect"`);
    return { ok: false, errors, warnings, rebuildOn: [...rebuildOn] };
  }
  if (!isObj(g.nodes)) E(`"graph.nodes" must be an object mapping names to node definitions`);

  const nodes = isObj(g.nodes) ? g.nodes : {};
  const known = new Set([...Object.keys(nodes), "in", "out"]);
  for (const reserved of ["in", "out"]) {
    if (reserved in nodes) E(`graph.nodes.${reserved} is reserved — "in" and "out" are created for you as gain nodes`);
  }

  for (const [name, def] of Object.entries(nodes)) {
    const at = `graph.nodes.${name}`;
    if (!NAME_RE.test(name)) E(`${at}: node names must be identifiers`);
    if (!isObj(def)) {
      E(`${at} must be an object`);
      continue;
    }
    const spec = NODE_TYPES[def.type];
    if (!spec) {
      E(`${at}.type "${def.type}" is not a node kind (known: ${Object.keys(NODE_TYPES).join(", ")})`);
      continue;
    }
    for (const [k, v] of Object.entries(def)) {
      if (k === "type") continue;
      if (k in COMMON_OPTS) {
        const allow = COMMON_OPTS[k];
        if (Array.isArray(allow) && !allow.includes(v)) E(`${at}.${k} must be one of ${allow.join(", ")}`);
        else if (allow === "number" && typeof v !== "number") E(`${at}.${k} must be a number`);
        continue;
      }
      if (k in spec.props) {
        const allow = spec.props[k].values;
        if (!allow.includes(v)) E(`${at}.${k} must be one of ${allow.join(", ")} (got ${JSON.stringify(v)})`);
        continue;
      }
      if (k in spec.opts) {
        const kind = spec.opts[k];
        if (kind === "number" && typeof v !== "number") E(`${at}.${k} must be a number`);
        if (kind === "boolean" && typeof v !== "boolean") E(`${at}.${k} must be true or false`);
        // A curve expression sees `x` (already in scope); an IR expression is
        // evaluated per sample and also sees `t` and `noise`.
        if (kind === "curve") validateRecipe(v, CURVE_KINDS, `${at}.curve`, E, value, exprWith([]));
        if (kind === "ir") validateRecipe(v, IR_KINDS, `${at}.ir`, E, value, exprWith(["t", "noise"]));
        continue;
      }
      warnings.push(`${at}.${k} is not an option of node kind "${def.type}"`);
    }
    if (def.type === "shaper" && def.curve == null) E(`${at}.curve is required for a shaper`);
    if (def.type === "convolver" && def.ir == null) E(`${at}.ir is required for a convolver`);
  }

  /* connections */
  const edges = Array.isArray(g.connect) ? g.connect : [];
  if (!Array.isArray(g.connect)) E(`"graph.connect" must be an array`);
  if (Array.isArray(g.connect) && !g.connect.length) E(`"graph.connect" is empty — nothing would reach "out"`);

  const checkEnd = (str, at, asSource) => {
    const ep = parseEndpoint(str);
    if (ep.error) return void E(`${at}: ${ep.error}`);
    if (!known.has(ep.node)) return void E(`${at}: no node named "${ep.node}"`);
    if (ep.param) {
      if (asSource) return void E(`${at}: "${str}" is an AudioParam and cannot be a source`);
      const spec = NODE_TYPES[nodes[ep.node]?.type];
      const list = ep.node === "in" || ep.node === "out" ? ["gain"] : (spec?.audioParams ?? []);
      if (!list.includes(ep.param)) {
        E(`${at}: "${ep.node}" has no AudioParam "${ep.param}" (has: ${list.join(", ") || "none"})`);
      }
    }
    return ep;
  };

  for (const [i, edge] of edges.entries()) {
    const at = `graph.connect[${i}]`;
    if (Array.isArray(edge)) {
      if (edge.length < 2) E(`${at} needs at least two endpoints`);
      edge.forEach((e, j) => checkEnd(e, `${at}[${j}]`, j < edge.length - 1));
    } else if (isObj(edge)) {
      if (!edge.from || !edge.to) E(`${at} needs "from" and "to"`);
      else {
        checkEnd(edge.from, `${at}.from`, true);
        checkEnd(edge.to, `${at}.to`, false);
      }
      if (edge.when != null) {
        if (typeof edge.when === "string" && keys.has(edge.when)) rebuildOn.add(edge.when);
        else if (typeof edge.when === "string") {
          if (expr(edge.when, `${at}.when`)) for (const k of names) if (edge.when.includes(k)) rebuildOn.add(k);
        } else E(`${at}.when must be a parameter key or an expression`);
      }
    } else E(`${at} must be an array of endpoints or a {from, to} object`);
  }

  /* bindings */
  const binds = Array.isArray(g.bind) ? g.bind : [];
  if (g.bind != null && !Array.isArray(g.bind)) E(`"graph.bind" must be an array`);
  for (const [i, b] of binds.entries()) {
    const at = `graph.bind[${i}]`;
    if (!isObj(b)) {
      E(`${at} must be an object`);
      continue;
    }
    if (b.param != null && !keys.has(b.param)) E(`${at}.param "${b.param}" is not a declared parameter`);
    if (b.param == null && b.map == null) E(`${at} needs "param", or "map" for a computed value`);
    if (b.map != null) expr(b.map, `${at}.map`);
    const ep = parseEndpoint(b.to ?? "");
    if (ep.error) {
      E(`${at}.to: ${ep.error}`);
      continue;
    }
    if (!known.has(ep.node)) {
      E(`${at}.to: no node named "${ep.node}"`);
      continue;
    }
    if (!ep.param) {
      E(`${at}.to must name an AudioParam or property, like "${ep.node}.gain"`);
      continue;
    }
    const nodeDef = ep.node === "in" || ep.node === "out" ? { type: "gain" } : nodes[ep.node];
    const spec = NODE_TYPES[nodeDef?.type];
    const isParam = spec?.audioParams.includes(ep.param);
    const isProp = spec && ep.param in spec.props;
    if (!isParam && !isProp) {
      E(
        `${at}.to: "${nodeDef?.type}" has no "${ep.param}" ` +
          `(AudioParams: ${spec?.audioParams.join(", ") || "none"}; properties: ${Object.keys(spec?.props ?? {}).join(", ") || "none"})`,
      );
    }
    if (isProp && b.map != null) warnings.push(`${at}.map is ignored for property "${ep.param}" — properties take the value as-is`);
    if (isProp && b.param) {
      const p = params.find((q) => q.key === b.param);
      const allowed = spec.props[ep.param].values;
      for (const c of p?.choices ?? []) if (!allowed.includes(c)) E(`${at}: choice "${c}" is not valid for ${ep.node}.${ep.param}`);
    }
  }

  /* reachability — a graph that never touches "out" is silent, which is
     almost always a typo rather than an intent. */
  if (!errors.length) {
    const feeds = new Set();
    for (const edge of edges) {
      const list = Array.isArray(edge) ? edge : [edge.from, edge.to];
      for (let i = 1; i < list.length; i++) {
        const ep = parseEndpoint(list[i]);
        if (!ep.error) feeds.add(ep.node);
      }
    }
    if (!feeds.has("out")) E(`nothing connects to "out" — the plugin would be silent`);
    const sources = new Set();
    for (const edge of edges) {
      const list = Array.isArray(edge) ? edge : [edge.from, edge.to];
      for (let i = 0; i < list.length - 1; i++) {
        const ep = parseEndpoint(list[i]);
        if (!ep.error) sources.add(ep.node);
      }
    }
    if (!sources.has("in")) warnings.push(`"in" is never connected — the plugin ignores its input signal`);
  }

  return { ok: errors.length === 0, errors, warnings, rebuildOn: [...rebuildOn] };
}

function validateRecipe(rec, kinds, at, E, value, expr) {
  if (!isObj(rec)) return void E(`${at} must be an object with a "kind"`);
  const spec = kinds[rec.kind];
  if (!spec) return void E(`${at}.kind "${rec.kind}" is unknown (known: ${Object.keys(kinds).join(", ")})`);
  for (const [f, type] of Object.entries(spec.fields)) {
    if (rec[f] == null) {
      E(`${at}.${f} is required for kind "${rec.kind}"`);
      continue;
    }
    if (type === "value") value(rec[f], `${at}.${f}`);
    if (type === "expr") expr(rec[f], `${at}.${f}`);
    if (type === "points") {
      if (!Array.isArray(rec[f]) || rec[f].length < 2) E(`${at}.${f} needs at least two [x, y] points`);
      else {
        let last = -Infinity;
        for (const [i, pt] of rec[f].entries()) {
          if (!Array.isArray(pt) || pt.length !== 2 || !pt.every(Number.isFinite)) E(`${at}.${f}[${i}] must be [x, y] numbers`);
          else if (pt[0] <= last) E(`${at}.${f}[${i}] x must ascend`);
          else last = pt[0];
        }
      }
    }
  }
  if (rec.size != null && (typeof rec.size !== "number" || rec.size < 2)) E(`${at}.size must be a number ≥ 2`);
}
