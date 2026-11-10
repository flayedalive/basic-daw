// 2.7 Loudness report and LUFS normalize, through the real bounce path.

import { test, assert, makeBuffer, sine, plucks, renderWith, openApp, sleep, fmt } from "../lib.js";
import { finishBounce } from "../../../src/audio/render.js";
import { measureBuffer } from "../../../src/audio/loudness.js";

const SR = 48000;

test("a bounced -23 dBFS 1 kHz tone reads -23.0 LUFS (EBU Tech 3341 case 1)", async () => {
  const out = await renderWith(makeBuffer(SR, 20, sine(1000, Math.pow(10, -23 / 20))));
  const r = measureBuffer(out);
  assert(Math.abs(r.integrated + 23) < 0.1, `integrated ${fmt(r.integrated)}`);
  assert(Math.abs(r.truePeakDb + 23) < 0.1, `true peak ${fmt(r.truePeakDb)}`);
  return `${fmt(r.integrated)} LUFS, ${fmt(r.truePeakDb)} dBTP`;
});

test("normalize to loudness lands on the target", async () => {
  const out = await renderWith(makeBuffer(SR, 8, plucks(0.2)));
  const before = measureBuffer(out).integrated;
  const { report, gainDb, limited } = finishBounce(out, { mode: "lufs", target: -20 });
  assert(!limited && Math.abs(report.integrated + 20) < 0.1, `landed at ${fmt(report.integrated)} LUFS`);
  return `${fmt(before, 1)} → ${fmt(report.integrated, 1)} LUFS (${fmt(gainDb, 1)} dB)`;
});

test("normalize to loudness holds the true peak under the ceiling and says how far short it fell", async () => {
  const out = await renderWith(makeBuffer(SR, 8, plucks(0.2)));
  const { report, limited, shortfall } = finishBounce(out, { mode: "lufs", target: -6 });
  assert(limited && shortfall > 0, "should have been limited by the ceiling");
  assert(Math.abs(report.truePeakDb + 1) < 0.05, `true peak ${fmt(report.truePeakDb)} dBTP`);
  assert(Math.abs(report.integrated + shortfall + 6) < 0.1, "shortfall does not add up");
  return `stopped at ${fmt(report.integrated, 1)} LUFS, ${fmt(shortfall, 1)} LU short, true peak ${fmt(report.truePeakDb, 2)} dBTP`;
});

test("bounce dialog: loudness option, then a report with every figure", async () => {
  const win = await openApp();
  const { daw } = win;
  daw.engine.ensure();
  const asset = await daw.pool.addAsset({ name: "plucks", buffer: makeBuffer(SR, 4, plucks(0.3)) });
  daw.timeline.dropAssetAt(asset.id, daw.state.project.tracks[0].id, 0);
  // Keep the file out of the test machine's downloads.
  win.HTMLAnchorElement.prototype.click = function () {};
  const { bounceDialog } = await win.eval('import("/src/project.js")');
  bounceDialog("master");
  await sleep(100);
  const doc = win.document;
  const norm = [...doc.querySelectorAll("#overlay select")].find((s) => [...s.options].some((o) => o.value === "lufs"));
  assert(norm, "no normalize-to-loudness option");
  norm.value = "lufs";
  norm.dispatchEvent(new win.Event("change"));
  const target = doc.querySelector("#overlay input[type=number]");
  assert(target && target.closest(".prow").style.display !== "none", "target field not shown");
  target.value = "-18";
  target.dispatchEvent(new win.Event("change"));
  [...doc.querySelectorAll("#overlay button")].find((b) => b.textContent === "Bounce").click();
  for (let i = 0; i < 200 && !doc.querySelector("#overlay h3")?.textContent.includes("report"); i++) await sleep(50);
  const text = doc.querySelector("#overlay").textContent;
  for (const label of ["Integrated", "Short-term max", "Loudness range", "True peak", "PLR"]) assert(text.includes(label), `report is missing "${label}"`);
  assert(/Integrated-18\.[01] LUFS/.test(text), `integrated not at target: ${text.slice(0, 120)}`);
  assert(!win.__errors.length, win.__errors.join("; "));
  return text.replace(/\s+/g, " ").slice(13, 110);
});
