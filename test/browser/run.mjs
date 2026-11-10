#!/usr/bin/env node
// End-to-end checks in headless Chrome, with no dependencies: a static server
// for the repo, Chrome started with fake audio devices, and the DevTools
// protocol spoken over Node's built-in WebSocket.
//
//   node test/browser/run.mjs              run every spec
//   node test/browser/run.mjs amp gate     run specs whose file name matches
//
// Specs live in test/browser/specs/*.js and run inside the page, importing the
// app's own modules — so they exercise the real registry, engine and renderer.

import { createServer } from "node:http";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".wav": "audio/wav", ".png": "image/png" };
const CHROME = process.env.CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
if (!CHROME) {
  console.error("No Chrome found; set CHROME=/path/to/chrome");
  process.exit(2);
}

const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const specs = (await readdir(join(ROOT, "test/browser/specs")))
  .filter((f) => f.endsWith(".js"))
  .filter((f) => !filters.length || filters.some((x) => f.includes(x)))
  .sort();

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  const file = join(ROOT, path === "/" ? "index.html" : path);
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = await mkdtemp(join(tmpdir(), "daw-test-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${join(ROOT, "test-audio/bass.wav")}`,
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let failed = 0;
try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === "Runtime.consoleAPICalled" && process.env.VERBOSE) {
      logs.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      logs.push(`EXC ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => (pending.set(++seq, { res, rej }), ws.send(JSON.stringify({ id: seq, method, params }))));
  await send("Runtime.enable");
  await send("Page.enable");

  for (const spec of specs) {
    await send("Page.navigate", { url: `${origin}/test/browser/harness.html?spec=${spec}` });
    let out;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const r = await send("Runtime.evaluate", { expression: "typeof window.__run", returnByValue: true }).catch(() => null);
      if (r?.result?.value === "function") break;
    }
    try {
      const r = await send("Runtime.evaluate", { expression: "window.__run()", awaitPromise: true, returnByValue: true, timeout: 600000 });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      out = r.result.value;
    } catch (err) {
      out = [{ name: "(spec failed to load)", ok: false, error: `${err.message}\n${logs.join("\n")}` }];
    }
    console.log(`\n${spec}`);
    for (const t of out) {
      console.log(`  ${t.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${t.name}${t.note ? `  \x1b[2m${t.note}\x1b[0m` : ""}`);
      if (!t.ok) {
        failed++;
        console.log(`      ${String(t.error).split("\n").join("\n      ")}`);
      }
    }
    if (process.env.VERBOSE && logs.length) console.log(logs.map((l) => `    | ${l}`).join("\n"));
    logs.length = 0;
  }
  ws.close();
} finally {
  chrome.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n\x1b[31m${failed} failed\x1b[0m` : "\n\x1b[32mall good\x1b[0m");
process.exit(failed ? 1 : 0);
