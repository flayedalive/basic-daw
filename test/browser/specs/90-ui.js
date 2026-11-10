// The app itself, booted in an iframe: the pieces of UI the plan added must
// render without errors and write to the document the way their controls say.

import { test, assert, openApp, sleep, makeBuffer, plucks } from "../lib.js";

let win;
const app = async () => (win ??= await openApp());
const $ = (sel) => win.document.querySelector(sel);
const $$ = (sel) => [...win.document.querySelectorAll(sel)];

/** Put a clip of plucked notes on track 1 and return { daw, track, clip }. */
async function seed() {
  const w = await app();
  const { daw } = w;
  daw.engine.ensure();
  if (!daw.state.project.clips.length) {
    const buffer = makeBuffer(48000, 4, plucks(0.4));
    const asset = await daw.pool.addAsset({ name: "plucks", buffer });
    daw.timeline.dropAssetAt(asset.id, daw.state.project.tracks[0].id, 0);
  }
  return { daw, track: daw.state.project.tracks[0], clip: daw.state.project.clips[0] };
}

async function showFx(type) {
  const { daw, track } = await seed();
  const fx = daw.plugins.newEffect(type);
  track.fx.push(fx);
  daw.engine.syncGraph();
  const { showInspector } = await win.eval('import("/src/ui/inspector.js")');
  showInspector({ kind: "fx", ownerId: track.id, fxId: fx.id });
  await sleep(120);
  return { daw, track, fx };
}

test("app boots with every plugin and no errors", async () => {
  const w = await app();
  const n = w.daw.plugins.allPlugins().length;
  const { loadErrors } = await w.eval('import("/src/plugins/loader.js")');
  assert(!loadErrors.length, JSON.stringify(loadErrors));
  assert(!w.__errors.length, w.__errors.join("; "));
  return `${n} plugins`;
});

test("amp editor: the cabinet IR picker lists the pool and sets the parameter", async () => {
  const { daw, fx } = await showFx("core.amp");
  const selects = $$("#insp-body select");
  const picker = selects.find((s) => [...s.options].some((o) => o.textContent.includes("none")));
  assert(picker, "no asset picker rendered");
  const option = [...picker.options].find((o) => o.textContent.startsWith("plucks"));
  assert(option, "pool file not offered");
  picker.value = option.value;
  picker.dispatchEvent(new win.Event("change"));
  await sleep(50);
  assert(fx.params.ir === option.value, "parameter not written");
  assert($$("#insp-body button").some((b) => b.textContent === "Load…"), "no Load… button");
  assert(!win.__errors.length, win.__errors.join("; "));
});

test("31-band graphic EQ: dragging the bank sets bands, in one undo step", async () => {
  const { daw, fx } = await showFx("core.geq31");
  const canvas = $("#insp-body canvas.geq-canvas");
  assert(canvas, "slider bank not mounted");
  assert($$("#insp-body input[type=range]").length === 1, "band parameters should not also render as 31 slider rows");
  const r = canvas.getBoundingClientRect();
  const fire = (type, fx, fy) => canvas.dispatchEvent(new win.PointerEvent(type, { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, pointerId: 1, bubbles: true }));
  const undoBefore = daw.state.dirty;
  fire("pointerdown", 0.1, 0.2);
  fire("pointermove", 0.5, 0.2);
  fire("pointerup", 0.9, 0.7);
  await sleep(80);
  const set = Object.entries(fx.params).filter(([k, v]) => k !== "out" && v !== 0);
  assert(set.length === 3, `expected 3 bands touched, got ${set.length}`);
  assert(set[0][1] > 0 && set[2][1] < 0, `values ${JSON.stringify(set)}`);
  daw.undo();
  await sleep(50);
  const after = daw.state.project.tracks[0].fx.find((f) => f.id === fx.id);
  assert(Object.entries(after.params).every(([k, v]) => k === "out" || v === 0), "one undo should restore the whole gesture");
  assert(!win.__errors.length, win.__errors.join("; "));
});

test("dynamics editors: bus compressor shows its controls and a moving reduction meter", async () => {
  const { daw, track, fx } = await showFx("core.buscomp");
  Object.assign(fx.params, { threshold: -40, ratio: 10 });
  daw.engine.updateMix();
  for (let i = 0; i < 100 && daw.engine.liveEffect(track.id, fx.id)?.pending; i++) await sleep(30);
  const meter = $("#insp-body .gr-meter i");
  assert(meter, "no reduction meter");
  assert($$("#insp-body select").some((s) => [...s.options].some((o) => o.value === "peak")), "no detector choice");
  await daw.engine.ctx.resume();
  daw.engine.play(0);
  await sleep(700);
  const live = daw.engine.liveEffect(track.id, fx.id);
  const reading = live.readout();
  const width = parseFloat(meter.style.width);
  daw.engine.stop();
  assert(reading < -3, `readout ${reading} dB while compressing hard`);
  assert(width > 5, `meter bar at ${width}%`);
  assert(!win.__errors.length, win.__errors.join("; "));
  return `reduction ${reading.toFixed(1)} dB, bar ${width.toFixed(0)}%`;
});
