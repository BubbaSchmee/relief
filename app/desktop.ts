/** Desktop mode: RELIEF running inside the Windows app (desktop/relief_desktop.py),
 *  which serves this page from 127.0.0.1 and adds a small local API: native ffmpeg
 *  for ProRes, and the native Save dialog.
 *
 *  It is on only when the page was opened with `?desktop=<token>` AND the server
 *  answers GET /api/desktop with that token. In any browser, on the public site or
 *  under `pnpm app`, `desktop` is null and nothing else here runs. */

export interface Desktop {
  /** A native ffmpeg is available (the packaged app always bundles one). */
  ffmpeg: boolean;
  createJob(): Promise<string>;
  /** One PNG frame, written to the job's folder on disk as it is produced. */
  putFrame(job: string, n: number, png: Uint8Array): Promise<void>;
  /** Encode the job's frames to ProRes 4444; resolves to the file size. */
  encode(job: string, fps: number): Promise<number>;
  /** Native Save dialog for the encoded file; the saved path, or null if cancelled. */
  saveJob(job: string, name: string): Promise<string | null>;
  /** Native Save dialog for any other export; the saved path, or null if cancelled. */
  saveBlob(blob: Blob, name: string): Promise<string | null>;
  /** Forget a job and delete its files (an aborted or failed export). */
  dropJob(job: string): Promise<void>;
}

async function detect(): Promise<Desktop | null> {
  const token = new URLSearchParams(location.search).get("desktop");
  if (!token) return null;

  const call = async (method: string, path: string, body?: BodyInit) => {
    const res = await fetch(path, { method, body, headers: { "X-Relief-Token": token } });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `the desktop app answered ${res.status}`);
    return json;
  };
  const q = (name: string) => encodeURIComponent(name);

  let info: Record<string, unknown>;
  try {
    info = await call("GET", "/api/desktop");
  } catch {
    return null; // a stale or foreign URL: behave as the plain web app
  }
  if (info.desktop !== true) return null;

  const saved = (r: Record<string, unknown>) => (typeof r.path === "string" ? r.path : null);
  return {
    ffmpeg: info.ffmpeg === true,
    async createJob() {
      return String((await call("POST", "/api/job")).id);
    },
    async putFrame(job, n, png) {
      await call("PUT", `/api/job/${job}/frame/${n}`, png as BodyInit);
    },
    async encode(job, fps) {
      return Number((await call("POST", `/api/job/${job}/encode?fps=${fps}`)).bytes);
    },
    async saveJob(job, name) {
      return saved(await call("POST", `/api/job/${job}/save?name=${q(name)}`));
    },
    async saveBlob(blob, name) {
      return saved(await call("POST", `/api/save?name=${q(name)}`, blob));
    },
    async dropJob(job) {
      await call("DELETE", `/api/job/${job}`).catch(() => {}); // already gone is fine
    },
  };
}

export const desktop: Desktop | null = await detect();
