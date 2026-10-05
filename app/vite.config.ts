import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const OUT = fileURLToPath(new URL("../.out", import.meta.url));

/** DEV SERVER ONLY (`apply: "serve"`: it does not exist in `vite build`).
 *  POST /__save?name=x writes the body to RELIEF/.out/x, so an export made in the
 *  browser can be checked with native ffprobe and ffmpeg. The name is a plain
 *  file name, the request must be same-origin, and the size is capped. */
function devSave(): Plugin {
  return {
    name: "relief-dev-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__save", (req, res) => {
        const name = new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "";
        const site = req.headers["sec-fetch-site"];
        if (req.method !== "POST" || !/^[\w][\w.-]{0,119}$/.test(name) || (site && site !== "same-origin")) {
          res.statusCode = 400;
          return res.end("bad request");
        }
        mkdirSync(OUT, { recursive: true });
        const file = createWriteStream(join(OUT, name));
        let bytes = 0;
        req.on("data", (c: Buffer) => {
          bytes += c.length;
          if (bytes > 2e9) req.destroy(new Error("too large"));
        });
        req.pipe(file);
        file.on("finish", () => { res.statusCode = 204; res.end(); });
        file.on("error", () => { res.statusCode = 500; res.end(); });
        req.on("error", () => file.destroy());
      });
    },
  };
}

// Root is app/ (`vite app`); ../src is imported as-is. Relative base so the
// built folder works from any path (file server, subfolder, itch-style hosting).
export default defineConfig({
  base: "./",
  plugins: [devSave()],
  // ffmpeg.wasm starts its worker with `new URL("./worker.js", import.meta.url)`;
  // pre-bundling would move the wrapper and break that path.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
  build: { target: "es2022", emptyOutDir: true },
});
