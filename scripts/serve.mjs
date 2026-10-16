// Run RELIEF as a local app: serve the built app (app/dist) on this machine
// only, and open it in the default browser. Nothing is uploaded anywhere;
// everything except ProRes export works offline (ProRes fetches its encoder
// from a CDN the first time it is used).
//
//   pnpm app          build, then serve and open
//   node scripts/serve.mjs [port] [--no-open]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../app/dist/", import.meta.url));
if (!existsSync(join(ROOT, "index.html"))) {
  console.error("app/dist is missing. Build it first: pnpm build:app");
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const file = normalize(join(ROOT, path === "/" ? "index.html" : path));
  // never serve anything outside app/dist
  if (!file.startsWith(normalize(ROOT)) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
});

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a))) || 5180;
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is busy: RELIEF may already be open. Try http://127.0.0.1:${port}/` : e.message);
  process.exit(1);
});
// 127.0.0.1 only: not reachable from other machines on the network
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`RELIEF is running at ${url}\nClose this window (or press Ctrl+C) to stop it.`);
  const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  if (!args.includes("--no-open")) exec(opener);
});
