// AudioWorklet modules for plugins.
//
// A plugin whose sound has to *read* the signal — a gate, a look-ahead limiter,
// a pitch corrector — runs sample-by-sample code in an AudioWorkletProcessor.
// The processor lives in a module that must be loaded into a context before a
// node can be made from it, and loading is asynchronous, while a plugin's
// `create` is not allowed to be. So loading is the host's job:
//
//   - a plugin declares `worklets: [{ name, url }]` (or `code` in place of `url`)
//   - the engine loads every registered module when the context is created, and
//     again whenever a plugin is installed; chains holding a worklet plugin are
//     built as passthroughs until then, and rebuilt once the modules are in
//   - the bounce awaits the same loading for its OfflineAudioContext before it
//     builds any chain, so a bounce never renders a passthrough
//
// Modules are loaded once per context and remembered in a WeakMap, the way
// audio/input.js handles its capture processor.

const registered = new Map(); // url -> Set(processor names)
const contexts = new WeakMap(); // ctx -> { urls: Set, loading: Promise | null }

/** Record a plugin's modules. Returns the list with every entry resolved to a `url`. */
export function registerWorklets(list = []) {
  return list.map((w) => {
    if (!w || typeof w.name !== "string" || !w.name) throw new Error('each worklet needs a "name" (the processor it registers)');
    let url = w.url;
    if (!url && typeof w.code === "string") url = URL.createObjectURL(new Blob([w.code], { type: "text/javascript" }));
    if (!url) throw new Error(`worklet "${w.name}" needs a "url" or "code"`);
    url = String(url);
    if (!registered.has(url)) registered.set(url, new Set());
    registered.get(url).add(w.name);
    return { name: w.name, url };
  });
}

const stateOf = (ctx) => {
  if (!contexts.has(ctx)) contexts.set(ctx, { urls: new Set(), loading: null });
  return contexts.get(ctx);
};

/** True when `ctx` has the given modules (default: every registered one) and nodes can be made. */
export function contextReady(ctx, list) {
  const urls = stateOf(ctx).urls;
  if (list) return list.every((w) => urls.has(w.url));
  for (const url of registered.keys()) if (!urls.has(url)) return false;
  return true;
}

/**
 * Load every registered module `ctx` does not have yet. Resolves when they are
 * all in; safe to call repeatedly and concurrently. A context without
 * AudioWorklet support (an insecure origin) rejects, and worklet plugins stay
 * passthroughs there.
 */
export function prepareContext(ctx) {
  const st = stateOf(ctx);
  if (contextReady(ctx)) return Promise.resolve();
  if (st.loading) return st.loading.then(() => prepareContext(ctx));
  if (!ctx.audioWorklet) return Promise.reject(new Error("AudioWorklet is not available in this context (it needs https or localhost)"));
  const missing = [...registered.keys()].filter((u) => !st.urls.has(u));
  st.loading = Promise.all(
    missing.map((url) =>
      ctx.audioWorklet.addModule(url).then(
        () => void st.urls.add(url),
        (err) => {
          throw new Error(`could not load worklet module ${url}: ${err.message}`);
        },
      ),
    ),
  ).finally(() => (st.loading = null));
  return st.loading.then(() => prepareContext(ctx));
}

/**
 * Make an AudioWorkletNode for a processor a plugin declared. Stereo in and
 * out with the channel count pinned, so the processor always sees two channels
 * and a bounce cannot differ from playback over how mono was up-mixed.
 */
export function workletNode(ctx, name, options = {}) {
  return new AudioWorkletNode(ctx, name, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    ...options,
  });
}
