// The tuner's face: note name, a ±50 cent meter, and a status line that says
// why it isn't hearing anything. Mounted by the inspector's effect editor for
// core.tuner, the same way the EQ editor mounts its response curve.
//
// It polls the live insert every animation frame and stops on its own once the
// inspector re-renders and drops the element — no subscription to clean up.

import { el } from "../util.js";
import { engine } from "../audio/engine.js";
import { state, trackById } from "../state.js";

const IN_TUNE = 2; // cents either side that count as in tune
const TICKS = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50];

/** Build the display for insert `fxId` on `ownerId` (a track id or "master"). */
export function tunerDisplay(ownerId, fxId) {
  const name = el("span.tn-name", null, "–");
  const oct = el("sub.tn-oct");
  const needle = el("div.tn-needle");
  const meter = el(
    "div.tn-meter",
    null,
    el("div.tn-zone", { style: { left: `${50 - IN_TUNE}%`, width: `${IN_TUNE * 2}%` } }),
    TICKS.map((c) => el(`div.tn-tick${c % 50 === 0 ? ".major" : ""}`, { style: { left: `${50 + c}%` } })),
    needle,
  );
  const scale = el(
    "div.tn-scale",
    null,
    [-50, -25, 0, 25, 50].map((c) => el("span", { style: { left: `${50 + c}%` } }, c > 0 ? `+${c}` : String(c))),
  );
  const cents = el("span.tn-cents", null, "");
  const hz = el("span.tn-hz", null, "");
  const status = el("div.tn-status");
  const root = el("div.tuner", null, el("div.tn-note", null, name, oct), meter, scale, el("div.tn-info", null, cents, hz), status);

  let mounted = false;
  let waited = 0;
  const frame = () => {
    if (root.isConnected) mounted = true;
    // Gone after being shown (the inspector re-rendered), or replaced before it
    // was ever attached: either way, stop polling.
    else if (mounted || ++waited > 10) return;
    if (mounted) paint();
    requestAnimationFrame(frame);
  };

  const paint = () => {
    const fx = engine.liveEffect(ownerId, fxId);
    const r = fx?.reading?.();
    if (!r?.active) {
      root.classList.remove("in-tune", "held");
      root.classList.add("idle");
      name.textContent = "–";
      oct.textContent = "";
      cents.textContent = "";
      hz.textContent = "";
      needle.style.left = "50%";
      status.textContent = idleReason(ownerId, fxId, fx, r);
      return;
    }
    const c = Math.max(-50, Math.min(50, r.cents));
    root.classList.remove("idle");
    root.classList.toggle("in-tune", Math.abs(r.cents) <= IN_TUNE);
    root.classList.toggle("held", !!r.held);
    name.textContent = r.name;
    oct.textContent = String(r.octave);
    needle.style.left = `${50 + c}%`;
    const shownCents = Math.abs(r.cents) < 0.05 ? 0 : r.cents;
    cents.textContent = `${shownCents > 0 ? "+" : shownCents < 0 ? "−" : ""}${Math.abs(shownCents).toFixed(1)} ¢`;
    hz.textContent = `${r.hz.toFixed(2)} Hz`;
    status.textContent = r.held ? "Holding last note" : Math.abs(r.cents) <= IN_TUNE ? "In tune" : r.cents < 0 ? "Flat — tune up" : "Sharp — tune down";
  };

  requestAnimationFrame(frame);
  return root;
}

/** The most useful thing to say when there is no note to show. */
function idleReason(ownerId, fxId, fx, r) {
  if (!engine.ctx) return "Click anywhere in the app to start audio.";
  const owner = ownerId === "master" ? state.project.master : trackById(ownerId);
  const def = owner?.fx.find((f) => f.id === fxId);
  if (def?.on === false) return "Bypassed — enable it to tune.";
  if (!fx) return "Starting…";
  const track = ownerId === "master" ? null : owner;
  const silent = !(r?.level > -90);
  if (silent && track && !(track.armed && track.monitor)) {
    return track.armed
      ? "No signal. Turn on Monitor (track inspector, or right-click the track header) so the input reaches this insert."
      : "No signal. To tune an input, arm this track and turn on Monitor (right-click the track header).";
  }
  if (silent) return "No signal.";
  const gate = def?.params?.gate ?? -60;
  if (r.level < gate) return `Input is ${r.level.toFixed(0)} dB, under the ${gate.toFixed(0)} dB gate.`;
  return `Listening (${r.level.toFixed(0)} dB) — play one note at a time.`;
}
