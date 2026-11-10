// The JSON plugins that ship with the app.
//
// Fetched rather than imported: `import ... with { type: "json" }` is still
// young enough that it would make the whole app fail to boot on a browser that
// lacks it, and this app already requires a static server (ES modules will not
// load over file://), so fetch costs nothing and works everywhere.
//
// To add one: drop the file in this folder and add its name below. Each is a
// worked example of a different manifest feature — see docs/plugins.md.

const FILES = [
  "tremolo", "autowah", "bitcrusher", "tube", "wavefolder", "plate", "tilt", "haas", "pingpong",
  // the pedal pack
  "overdrive", "distortion", "fuzz", "boost", "phaser", "flanger", "octaveup",
];

/** Fetch every bundled manifest. Returns { manifests, errors }. */
export async function loadBundled() {
  const base = new URL("./", import.meta.url);
  const results = await Promise.all(
    FILES.map(async (name) => {
      try {
        const res = await fetch(new URL(`${name}.json`, base), { cache: "force-cache" });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return { manifest: await res.json() };
      } catch (err) {
        return { error: { id: name, source: "bundled", message: err.message } };
      }
    }),
  );
  return {
    manifests: results.filter((r) => r.manifest).map((r) => r.manifest),
    errors: results.filter((r) => r.error).map((r) => r.error),
  };
}
