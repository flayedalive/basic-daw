// Audio setup dialog: choose the input and output devices, watch each input's
// level, and set the round-trip latency that takes are shifted back by.

import { clamp, coalesce, dialog, el, toast } from "../util.js";
import { bus } from "../state.js";
import { engine } from "../audio/engine.js";
import {
  canChooseOutput,
  input,
  listDevices,
  loadPrefs,
  requestPermission,
  savePrefs,
  setOutputDevice,
} from "../audio/input.js";

const ms = (s) => `${(s * 1000).toFixed(1)} ms`;

export function audioSetup() {
  engine.ensure();
  dialog("Audio setup", (body) => {
    let openError = null;
    let calibrating = false;
    let calStatus = null;
    let meters = []; // { fill, val, shown, hold, holdUntil }

    const tryOpen = () =>
      input
        .acquire("meter")
        .then(() => (openError = null))
        .catch((err) => (openError = err))
        .finally(render);

    const render = coalesce(async () => {
      if (!body.isConnected) return;
      const devs = await listDevices().catch(() => ({ inputs: [], outputs: [], labelled: false }));
      const prefs = loadPrefs();
      body.replaceChildren(inputSection(devs, prefs), outputSection(devs, prefs), latencySection(prefs), aboutNote());
    });

    /* ── input ───────────────────────────────────────────────────────── */

    function inputSection(devs, prefs) {
      const items = [];
      if (!devs.labelled) {
        items.push(
          el(
            "div.insp-empty",
            null,
            "Your browser hides device names until this page may use the microphone.",
          ),
          el(
            "div.btnrow",
            null,
            el("button.btn.primary", {
              textContent: "Allow microphone access",
              onclick: () => requestPermission().then(tryOpen, (e) => toast(`Permission refused: ${e.message}`, "err")),
            }),
          ),
        );
      }

      const sel = deviceSelect(devs.inputs, prefs.inputId || "", "System default input", async (id) => {
        try {
          await input.setInputDevice(id);
          openError = null;
          if (!input.open) await tryOpen();
        } catch (err) {
          openError = err;
        }
        render();
      });
      sel.disabled = engine.recording;
      items.push(el("div.prow", null, el("label", null, "Device"), sel));

      if (openError) {
        items.push(
          el("div.plug-warn", null, el("b", null, "Input unavailable"), el("div.a-meta", null, openError.message || openError.name)),
          el("div.btnrow", null, el("button.btn", { textContent: "Try again", onclick: tryOpen })),
        );
      } else if (!input.open) {
        items.push(el("div.insp-empty", null, "Opening the input…"));
      } else {
        const n = input.channels;
        items.push(
          el(
            "div.insp-empty",
            null,
            `${input.deviceLabel} · ${n} input${n > 1 ? "s" : ""}${input.fellBack ? " · saved device missing, using the default" : ""}`,
          ),
        );
        meters = [];
        for (let c = 0; c < n; c++) {
          const fill = el("i");
          const val = el("span.val", null, "-∞");
          meters.push({ fill, val, shown: 0, hold: 0, holdUntil: 0 });
          items.push(el("div.prow", null, el("label", null, `In ${c + 1}`), el("div.as-meter.grow", null, fill), val));
        }
        items.push(
          el(
            "div.insp-empty",
            null,
            "Echo cancellation, noise suppression and auto gain are off, so instruments record clean. Pick which input each track records from by right-clicking its header, or in its inspector.",
          ),
        );
      }
      return sec("Input", items);
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

    function latencySection(prefs) {
      const est = input.estimatedLatency();
      const comp = input.compensation();
      const offset = el("input.num", {
        type: "number",
        step: "0.1",
        min: "0",
        max: "1000",
        placeholder: (est.total * 1000).toFixed(1),
        value: prefs.latencyMs != null ? String(prefs.latencyMs) : "",
        title: "Leave empty to use the browser's estimate",
        onchange: (e) => {
          const v = e.target.value.trim();
          savePrefs({ latencyMs: v === "" ? null : clamp(Number(v) || 0, 0, 1000) });
          render();
        },
      });

      const calBtn = el("button.btn.primary", {
        textContent: calibrating ? "Listening…" : "Calibrate",
        disabled: calibrating || engine.recording,
        onclick: calibrate,
      });
      const resetBtn =
        prefs.latencyMs != null
          ? el("button.btn", {
              textContent: "Use estimate",
              onclick: () => {
                savePrefs({ latencyMs: null });
                calStatus = null;
                render();
              },
            })
          : null;

      return sec("Latency", [
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
        calStatus,
        el(
          "div.insp-empty",
          null,
          "Takes are moved earlier by this much so they line up with what you heard. To measure it, run a cable from an output to an input (or hold a mic near the speakers), turn monitoring off, and press Calibrate: six clicks are played and timed on their way back in.",
        ),
      ]);
    }

    async function calibrate() {
      calibrating = true;
      calStatus = el("div.insp-empty", null, "Playing test clicks — keep the room quiet…");
      render();
      try {
        const r = await input.calibrate();
        savePrefs({ latencyMs: r.ms });
        const shaky = r.spread > 3;
        calStatus = el(
          shaky ? "div.plug-warn" : "div.insp-empty",
          null,
          `Measured ${r.ms} ms — heard ${r.hits}/${r.of} clicks on In ${r.channel}, spread ${r.spread} ms.`,
          shaky ? " The clicks were inconsistent; a cable loop measures more reliably than speakers and a mic." : "",
        );
        toast(`Latency set to ${r.ms} ms`, "ok");
      } catch (err) {
        calStatus = el("div.plug-warn", null, el("b", null, "Calibration failed"), el("div.a-meta", null, err.message));
      } finally {
        calibrating = false;
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
        if (info?.lost) openError = new Error("the input device was disconnected");
        render();
      }),
    ];
    const onDevChange = () => render();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDevChange);

    const frame = () => {
      if (!body.isConnected) {
        // Dialog closed (button, Esc or click outside): let the input go.
        unsubs.forEach((u) => u());
        navigator.mediaDevices?.removeEventListener?.("devicechange", onDevChange);
        input.release("meter");
        return;
      }
      if (input.open && meters.length) {
        const lv = input.levels();
        const now = performance.now();
        meters.forEach((m, i) => {
          const p = lv[i] ?? 0;
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
        });
      }
      requestAnimationFrame(frame);
    };

    render();
    tryOpen();
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
