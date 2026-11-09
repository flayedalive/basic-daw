// Audio setup dialog: choose the main input and the output, watch every input
// in use (with clip lights), and set the round-trip latency that takes are
// shifted back by — per device, since each settles at its own delay.

import { clamp, coalesce, dialog, el, toast } from "../util.js";
import { bus, state } from "../state.js";
import { engine } from "../audio/engine.js";
import {
  canChooseOutput,
  input,
  listDevices,
  loadPrefs,
  requestPermission,
  setOutputDevice,
} from "../audio/input.js";

const ms = (s) => `${(s * 1000).toFixed(1)} ms`;

export function audioSetup() {
  engine.ensure();
  dialog("Audio setup", (body) => {
    const errors = new Map(); // device key -> Error from opening it
    const held = new Set(); // device keys this dialog is holding open
    let calibrating = null; // device key being calibrated
    const calStatus = new Map(); // device key -> status element
    let meters = []; // { key, c, fill, val, led, shown, hold, holdUntil }

    /** Device keys tracks in this project record from, other than the main input. */
    const otherKeys = () => [...new Set(state.project.tracks.map((t) => input.keyOf(t)).filter(Boolean))];

    const hold = (key) => {
      held.add(key);
      return input
        .acquire("meter", key)
        .then(() => errors.delete(key))
        .catch((err) => errors.set(key, err))
        .finally(render);
    };
    const holdAll = () => Promise.all(["", ...otherKeys()].filter((k) => !held.has(k)).map(hold));

    const render = coalesce(async () => {
      if (!body.isConnected) return;
      const devs = await listDevices().catch(() => ({ inputs: [], outputs: [], labelled: false }));
      const prefs = loadPrefs();
      meters = [];
      body.replaceChildren(
        mainSection(devs, prefs),
        otherSection(devs),
        outputSection(devs, prefs),
        latencySection(),
        aboutNote(),
      );
    });

    /* ── inputs ──────────────────────────────────────────────────────── */

    function mainSection(devs, prefs) {
      const items = [];
      if (!devs.labelled) {
        items.push(
          el("div.insp-empty", null, "Your browser hides device names until this page may use the microphone."),
          el(
            "div.btnrow",
            null,
            el("button.btn.primary", {
              textContent: "Allow microphone access",
              onclick: () => requestPermission().then(() => hold(""), (e) => toast(`Permission refused: ${e.message}`, "err")),
            }),
          ),
        );
      }

      const sel = deviceSelect(devs.inputs, prefs.inputId || "", "System default input", async (id) => {
        try {
          await input.setInputDevice(id);
          held.clear();
          errors.clear();
          await holdAll();
        } catch (err) {
          errors.set("", err);
        }
        render();
      });
      sel.disabled = engine.recording;
      items.push(el("div.prow", null, el("label", null, "Device"), sel));
      items.push(...deviceBody("", input.main.fellBack ? " · saved device missing, using the default" : ""));
      items.push(
        el(
          "div.insp-empty",
          null,
          "Echo cancellation, noise suppression and auto gain are off, so instruments record clean. Pick which input each track records from by right-clicking its header, or in its inspector. CLIP lights when an input reaches full scale — turn the gain down on the interface itself; a track's fader can't undo it.",
        ),
      );
      return sec("Main input", items);
    }

    function otherSection(devs) {
      const keys = otherKeys();
      const others = devs.inputs.filter((d) => !["default", "communications", ""].includes(d.deviceId) && input.keyFor(d.deviceId) !== "");
      if (!keys.length) {
        if (!others.length) return null;
        return sec("Other inputs", [
          el(
            "div.insp-empty",
            null,
            `Also connected: ${others.map((d) => d.label || "unnamed device").join(", ")}. To record from one alongside the main input, choose it from a track's input menu — each track can use a different device.`,
          ),
        ]);
      }
      const items = [];
      for (const key of keys) {
        items.push(el("div.as-dev", null, input.nameOf(key)));
        items.push(...deviceBody(key, ""));
      }
      items.push(
        el(
          "div.insp-empty",
          null,
          "Each device runs on its own clock. Takes are lined up using each one's own latency (below); on very long takes a separate device can drift by a few milliseconds.",
        ),
      );
      return sec("Other inputs", items);
    }

    /** Status line and per-channel meters for one device. */
    function deviceBody(key, note) {
      const err = errors.get(key);
      const dev = input.devices.get(key);
      if (err) {
        return [
          el("div.plug-warn", null, el("b", null, "Input unavailable"), el("div.a-meta", null, err.message || err.name)),
          el("div.btnrow", null, el("button.btn", { textContent: "Try again", onclick: () => hold(key) })),
        ];
      }
      if (!dev?.open) return [el("div.insp-empty", null, "Opening the input…")];
      const n = dev.channels;
      const out = [el("div.insp-empty", null, `${dev.label} · ${n} input${n > 1 ? "s" : ""}${note}`)];
      for (let c = 0; c < n; c++) {
        const fill = el("i");
        const val = el("span.val", null, "-∞");
        const led = el(
          "span.as-clip",
          {
            title: "Reached full scale — click to clear",
            onclick: () => {
              dev.clip[c] = false;
            },
          },
          "CLIP",
        );
        meters.push({ key, c, fill, val, led, shown: 0, hold: 0, holdUntil: 0 });
        out.push(el("div.prow", null, el("label", null, `In ${c + 1}`), el("div.as-meter.grow", null, fill), val, led));
      }
      return out;
    }

    /* ── output ──────────────────────────────────────────────────────── */

    function outputSection(devs, prefs) {
      if (!canChooseOutput()) {
        return sec("Output", [
          el("div.insp-empty", null, "This browser plays through the system's default output. Chrome and Edge can pick a device here."),
        ]);
      }
      const sel = deviceSelect(devs.outputs, prefs.outputId || "", "System default output", async (id) => {
        try {
          await setOutputDevice(id);
          toast("Output device changed", "ok");
        } catch (err) {
          toast(`Couldn't switch output: ${err.message}`, "err", 5000);
        }
        render();
      });
      return sec("Output", [el("div.prow", null, el("label", null, "Device"), sel)]);
    }

    /* ── latency ─────────────────────────────────────────────────────── */

    function latencySection() {
      const keys = ["", ...otherKeys()];
      const items = [];
      for (const key of keys) {
        if (keys.length > 1) items.push(el("div.as-dev", null, input.nameOf(key)));
        items.push(...latencyRows(key));
      }
      items.push(
        el(
          "div.insp-empty",
          null,
          "Takes are moved earlier by this much so they line up with what you heard. To measure it, run a cable from an output to an input (or hold the mic near the speakers), turn monitoring off, and press Calibrate: six clicks are played and timed on their way back in.",
        ),
      );
      return sec("Latency", items);
    }

    function latencyRows(key) {
      const est = input.estimatedLatency(key);
      const comp = input.compensation(key);
      const saved = input.savedLatency(key);
      const offset = el("input.num", {
        type: "number",
        step: "0.1",
        min: "0",
        max: "1000",
        placeholder: (est.total * 1000).toFixed(1),
        value: saved != null ? String(saved) : "",
        title: "Leave empty to use the browser's estimate",
        onchange: (e) => {
          const v = e.target.value.trim();
          input.setSavedLatency(key, v === "" ? null : clamp(Number(v) || 0, 0, 1000));
          render();
        },
      });
      const calBtn = el("button.btn.primary", {
        textContent: calibrating === key ? "Listening…" : "Calibrate",
        disabled: calibrating != null || engine.recording,
        onclick: () => calibrate(key),
      });
      const resetBtn =
        saved != null
          ? el("button.btn", {
              textContent: "Use estimate",
              onclick: () => {
                input.setSavedLatency(key, null);
                calStatus.delete(key);
                render();
              },
            })
          : null;
      return [
        el(
          "div.prow",
          null,
          el("label", null, "Reported"),
          el("span.grow", null, `${ms(est.total)} (output ${ms(est.output)} · input ${ms(est.input)})`),
        ),
        el(
          "div.prow",
          null,
          el("label", null, "Shift takes"),
          offset,
          el("span.a-meta", null, `ms · ${comp.source === "calibrated" ? "measured / set" : "using the estimate"}`),
        ),
        el("div.btnrow", null, calBtn, resetBtn),
        calStatus.get(key) ?? null,
      ];
    }

    async function calibrate(key) {
      calibrating = key;
      calStatus.set(key, el("div.insp-empty", null, "Playing test clicks — keep the room quiet…"));
      render();
      try {
        const r = await input.calibrate(key);
        input.setSavedLatency(key, r.ms);
        const shaky = r.spread > 3;
        calStatus.set(
          key,
          el(
            shaky ? "div.plug-warn" : "div.insp-empty",
            null,
            `Measured ${r.ms} ms — heard ${r.hits}/${r.of} clicks on In ${r.channel}, spread ${r.spread} ms.`,
            shaky ? " The clicks were inconsistent; a cable loop measures more reliably than speakers and a mic." : "",
          ),
        );
        toast(`Latency for ${input.nameOf(key)} set to ${r.ms} ms`, "ok");
      } catch (err) {
        calStatus.set(key, el("div.plug-warn", null, el("b", null, "Calibration failed"), el("div.a-meta", null, err.message)));
      } finally {
        calibrating = null;
        render();
      }
    }

    function aboutNote() {
      return el(
        "div.insp-empty",
        null,
        "Basic DAW reaches your interface through its standard system driver — a browser can't load ASIO — so there is nothing to install. Device and latency choices are remembered in this browser.",
      );
    }

    /* ── meters ──────────────────────────────────────────────────────── */

    const unsubs = [
      bus.on("audioinput", (info) => {
        if (info?.lost) errors.set(info.key ?? "", new Error("the input device was disconnected"));
        render();
      }),
      // A track switched to a new device while the dialog is open: start metering it.
      bus.on("mix", () => holdAll()),
    ];
    const onDevChange = () => render();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDevChange);

    const frame = () => {
      if (!body.isConnected) {
        // Dialog closed (button, Esc or click outside): let the inputs go.
        unsubs.forEach((u) => u());
        navigator.mediaDevices?.removeEventListener?.("devicechange", onDevChange);
        for (const key of held) input.release("meter", key);
        return;
      }
      if (meters.length) {
        const now = performance.now();
        const byKey = new Map();
        for (const m of meters) {
          const dev = input.devices.get(m.key);
          if (!dev?.open) continue;
          if (!byKey.has(m.key)) byKey.set(m.key, dev.levels());
          const p = byKey.get(m.key)[m.c] ?? 0;
          const db = p > 0 ? 20 * Math.log10(p) : -Infinity;
          const t = clamp(1 + (isFinite(db) ? db : -60) / 60, 0, 1);
          m.shown = t > m.shown ? t : m.shown * 0.9;
          m.fill.style.width = `${(m.shown * 100).toFixed(1)}%`;
          if (p > m.hold || now > m.holdUntil) {
            m.hold = p;
            m.holdUntil = now + 1500;
            m.val.textContent = isFinite(db) ? db.toFixed(1) : "-∞";
            m.val.classList.toggle("clip", db > -0.5);
          }
          const clip = !!dev.clip[m.c];
          if (m.led.classList.contains("on") !== clip) m.led.classList.toggle("on", clip);
        }
      }
      requestAnimationFrame(frame);
    };

    render();
    holdAll();
    requestAnimationFrame(frame);
  });
}

function sec(title, children) {
  return el("div.sec", null, el("h3", null, title), el("div.sec-body", null, ...children));
}

function deviceSelect(devices, current, defaultLabel, onChange) {
  const s = el("select.select.grow", { onchange: (e) => onChange(e.target.value) });
  s.append(el("option", { value: "", selected: current === "" }, defaultLabel));
  let found = current === "";
  devices.forEach((d, i) => {
    // "default" / "communications" are aliases of real devices on Windows.
    if (d.deviceId === "default" || d.deviceId === "communications" || d.deviceId === "") return;
    const on = d.deviceId === current;
    found ||= on;
    s.append(el("option", { value: d.deviceId, selected: on }, d.label || `Device ${i + 1}`));
  });
  if (!found) s.append(el("option", { value: current, selected: true }, "Saved device (not connected)"));
  return s;
}
