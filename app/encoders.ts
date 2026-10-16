/** The three transparent formats. Every encoder is fed OUR straight-RGBA frames
 *  (src/frames.ts) — never `new VideoFrame(canvas)`, which Chrome hands over
 *  straight and Firefox premultiplied (verified 2026-10-04), the difference
 *  between a clean edge and a dark fringe.
 *
 *  PNG zip   fflate, PNGs stored (they are already compressed).
 *  WebM      Mediabunny: VP9 colour + VP9 alpha as two encoders, muxed as
 *            Matroska alpha. WebCodecs' own `alpha: "keep"` is unsupported in
 *            Chrome and WebKit and a silent no-op in Firefox.
 *  ProRes    ffmpeg.wasm. Its core is GPL-2.0-or-later (it is built with x264 and
 *            x265), so it is NOT bundled or installed: it is fetched from a CDN
 *            at runtime, only when ProRes is chosen, and checked against a
 *            pinned hash before it runs.
 *            In the Windows desktop app (app/desktop.ts) the same ffmpeg command
 *            runs natively instead: each PNG frame is streamed to disk as it is
 *            made, so there is no download and no memory cap. */
import { Zip, ZipPassThrough } from "fflate";
import { encodePng } from "../src/png.js";
import { rgbaToI420A } from "../src/yuv.js";
import { desktop, type Desktop } from "./desktop.js";

export type FormatId = "prores" | "webm" | "png";

export interface Job {
  w: number;
  h: number;
  fps: number;
  frames: number;
  /** Base file name, no extension. */
  name: string;
}

export interface Encoded {
  /** The finished file, for the encoders that build it in memory. */
  blob?: Blob;
  /** The desktop app's ProRes: the file is still on disk in this job, ready for the Save dialog. */
  job?: string;
  bytes: number;
  ext: string;
}

export interface Encoder {
  add(rgba: Uint8ClampedArray, i: number): Promise<void>;
  finish(): Promise<Encoded>;
  abort(): void;
}

/** `status` carries human text ("Downloading encoder, 12 MB", "Encoding 40%"). */
export type Status = (text: string) => void;

const pad = (n: number) => String(n).padStart(4, "0");

// ---------------------------------------------------------------- PNG sequence
async function pngZip(job: Job): Promise<Encoder> {
  const chunks: BlobPart[] = [];
  let finished!: (b: Blob) => void;
  let failed!: (e: Error) => void;
  const done = new Promise<Blob>((res, rej) => { finished = res; failed = rej; });
  const zip = new Zip((err, chunk, final) => {
    if (err) return failed(err);
    chunks.push(chunk as BlobPart);
    if (final) finished(new Blob(chunks, { type: "application/zip" }));
  });
  // a fixed LOCAL date: fflate writes DOS time from local fields, so this is the
  // same bytes in every timezone and on every run
  const mtime = new Date(2020, 0, 1, 0, 0, 0);
  return {
    async add(rgba, i) {
      const f = new ZipPassThrough(`${job.name}_${job.fps}fps_${pad(i + 1)}.png`);
      f.mtime = mtime;
      zip.add(f);
      f.push(encodePng(rgba, job.w, job.h), true);
    },
    async finish() {
      zip.end();
      const blob = await done;
      return { blob, bytes: blob.size, ext: "zip" };
    },
    abort() { zip.terminate(); },
  };
}

// ---------------------------------------------------------------- transparent WebM
async function webm(job: Job): Promise<Encoder> {
  const mb = await import("mediabunny");
  const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const source = new mb.VideoSampleSource({
    codec: "vp9",
    alpha: "keep",
    quality: mb.QUALITY_VERY_HIGH,
    keyFrameInterval: 1, // a keyframe every second: editors scrub it comfortably
  });
  output.addVideoTrack(source, { frameRate: job.fps, canBeTransparent: true });
  await output.start();
  const us = (i: number) => Math.round((i * 1e6) / job.fps);
  return {
    async add(rgba, i) {
      // We convert to I420A ourselves, BT.709 limited, and say so: browsers
      // disagree on the matrix for an RGBA frame (src/yuv.ts).
      const frame = new VideoFrame(rgbaToI420A(rgba, job.w, job.h), {
        format: "I420A",
        codedWidth: job.w,
        codedHeight: job.h,
        timestamp: us(i),
        duration: us(i + 1) - us(i),
        colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
      });
      const sample = new mb.VideoSample(frame);
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    },
    async finish() {
      await output.finalize();
      const blob = new Blob([output.target.buffer as ArrayBuffer], { type: "video/webm" });
      return { blob, bytes: blob.size, ext: "webm" };
    },
    abort() { void output.cancel(); },
  };
}

// ---------------------------------------------------------------- ProRes 4444 via ffmpeg.wasm
const CORE_VERSION = "0.12.10";
/** The two CDNs serve byte-identical files (checked 2026-10-04); either may be down. */
const CORE_BASES = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];
const CORE_SHA256 = {
  "ffmpeg-core.js": "67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3",
  "ffmpeg-core.wasm": "9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7",
} as const;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function fetchCore(file: keyof typeof CORE_SHA256, type: string, status: Status): Promise<string> {
  let lastError: unknown;
  for (const base of CORE_BASES) {
    try {
      const res = await fetch(`${base}/${file}`);
      if (!res.ok || !res.body) throw new Error(`${res.status} from ${base}`);
      const parts: Uint8Array[] = [];
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        status(`Downloading the ProRes encoder (${file}), ${(got / 1e6).toFixed(1)} MB`);
      }
      const bytes = new Uint8Array(got);
      let o = 0;
      for (const p of parts) { bytes.set(p, o); o += p.length; }
      // this code is about to run in the page: only the exact file we pinned
      if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== CORE_SHA256[file]) throw new Error(`${file} from ${base} does not match its pinned SHA-256`);
      return URL.createObjectURL(new Blob([bytes], { type }));
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Could not fetch the ProRes encoder from the CDN (${lastError instanceof Error ? lastError.message : String(lastError)}). Check your connection, or choose PNG sequence.`);
}

async function prores(job: Job, status: Status): Promise<Encoder> {
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const coreURL = await fetchCore("ffmpeg-core.js", "text/javascript", status);
  const wasmURL = await fetchCore("ffmpeg-core.wasm", "application/wasm", status);
  status("Starting the ProRes encoder");
  const ff = new FFmpeg();
  await ff.load({ coreURL, wasmURL });
  URL.revokeObjectURL(coreURL);
  URL.revokeObjectURL(wasmURL);
  return {
    async add(rgba, i) {
      // level 1: these PNGs live in memory for a minute and are then thrown away
      await ff.writeFile(`f${pad(i)}.png`, encodePng(rgba, job.w, job.h, 1));
    },
    async finish() {
      ff.on("progress", ({ progress }) => status(`Encoding ProRes 4444, ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`));
      status("Encoding ProRes 4444");
      const code = await ff.exec([
        "-framerate", String(job.fps),
        "-i", "f%04d.png",
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le",
        "-c:v", "prores_ks", "-profile:v", "4444", "-alpha_bits", "16", "-vendor", "apl0",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        // ffmpeg 5.1's prores_ks leaves the frame header's colour fields "unspecified"
        // (the .mov's colr atom says bt709, the frame header said nothing); a decoder
        // that trusts the header then guesses BT.601 and the pink shifts by dE 5.
        // This filter writes bt709 into every frame header too. Verified 2026-10-04.
        "-bsf:v", "prores_metadata=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        "out.mov",
      ]);
      if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
      const data = (await ff.readFile("out.mov")) as Uint8Array;
      ff.terminate(); // frees the wasm heap
      return { blob: new Blob([data as BlobPart], { type: "video/quicktime" }), bytes: data.length, ext: "mov" };
    },
    abort() { ff.terminate(); },
  };
}

// ---------------------------------------------------------------- ProRes 4444 via native ffmpeg (desktop app)
async function proresNative(job: Job, status: Status, d: Desktop): Promise<Encoder> {
  const id = await d.createJob();
  return {
    async add(rgba, i) {
      // streamed: one frame in memory at a time, however long or large the clip
      await d.putFrame(id, i, encodePng(rgba, job.w, job.h, 1));
    },
    async finish() {
      status("Encoding ProRes 4444 with the bundled ffmpeg");
      return { job: id, bytes: await d.encode(id, job.fps), ext: "mov" };
    },
    abort() { void d.dropJob(id); },
  };
}

export function createEncoder(format: FormatId, job: Job, status: Status): Promise<Encoder> {
  if (format === "prores") return desktop ? proresNative(job, status, desktop) : prores(job, status);
  return format === "png" ? pngZip(job) : webm(job);
}
