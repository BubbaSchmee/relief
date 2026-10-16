/** GLB export gate: re-parse the bytes ourselves, then ask Khronos. */
import { validateBytes } from "gltf-validator";
import { describe, expect, it } from "vitest";
import { hexToBaseColorFactor } from "../src/color.js";
import { meshToGlb } from "../src/gltf.js";
import { buildMesh } from "../src/mesh.js";
import { traceAlpha } from "../src/trace.js";
import { FaceKind, type Mesh, type Region } from "../src/types.js";
import { FIXTURES, loadWordmark, WORDMARK_HEX } from "./fixtures.js";

const png = loadWordmark();
const BRAND = WORDMARK_HEX;
const regions: Region[] = traceAlpha(png).map((s) => ({ hex: BRAND, outer: s.outer, holes: s.holes }));
const mesh = buildMesh(regions, { source: { width: png.width, height: png.height } });

/** Independent GLB reader — deliberately shares no code with src/gltf.ts. */
function parse(glb: Uint8Array) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const header = { magic: dv.getUint32(0, true), version: dv.getUint32(4, true), length: dv.getUint32(8, true) };
  const jsonLen = dv.getUint32(12, true);
  const jsonType = dv.getUint32(16, true);
  const jsonText = new TextDecoder().decode(glb.subarray(20, 20 + jsonLen));
  const binHead = 20 + jsonLen;
  const binLen = dv.getUint32(binHead, true);
  const binType = dv.getUint32(binHead + 4, true);
  return { header, jsonLen, jsonType, jsonText, json: JSON.parse(jsonText), binHead, binLen, binType };
}

describe("meshToGlb: raster wordmark", () => {
  const glb = meshToGlb(mesh);
  const p = parse(glb);
  console.log(`wordmark glb: ${glb.byteLength} bytes, ${p.json.meshes[0].primitives.length} primitives, ${p.json.materials.length} materials`);

  it("has a correct container: magic, version, length, aligned chunks", () => {
    expect(p.header.magic).toBe(0x46546c67);
    expect(p.header.version).toBe(2);
    expect(p.header.length).toBe(glb.byteLength);
    expect(p.jsonType).toBe(0x4e4f534a);
    expect(p.binType).toBe(0x004e4942);
    expect(p.jsonLen % 4).toBe(0);
    expect(p.binLen % 4).toBe(0);
    expect(20 + p.jsonLen + 8 + p.binLen).toBe(glb.byteLength);
    // JSON padding is spaces: the text parses and any tail beyond the closing brace is blank
    expect(p.jsonText.slice(p.jsonText.lastIndexOf("}") + 1).trim()).toBe("");
    for (const bv of p.json.bufferViews) expect(bv.byteOffset % 4).toBe(0);
    expect(p.json.buffers[0].byteLength).toBeLessThanOrEqual(p.binLen);
  });

  it("FRONT materials carry the exact linear hex, unrounded", () => {
    const want = hexToBaseColorFactor(BRAND);
    const front = p.json.materials.filter((m: { name: string }) => m.name.startsWith("front "));
    expect(front.length).toBe(regions.length);
    for (const m of front) {
      expect(m.name).toBe(`front ${BRAND}`);
      const got = m.pbrMetallicRoughness.baseColorFactor;
      for (let c = 0; c < 4; c++) expect(got[c]).toBe(want[c]);
      expect(m.pbrMetallicRoughness.metallicFactor).toBe(0);
      expect(m.pbrMetallicRoughness.roughnessFactor).toBe(0.5);
      expect(m.extensions).toBeUndefined();
    }
    const metal = p.json.materials.filter((m: { name: string }) => m.name === "metal");
    expect(metal.length).toBe(1);
    expect(metal[0].pbrMetallicRoughness).toEqual({ baseColorFactor: [0.75, 0.75, 0.78, 1], metallicFactor: 1, roughnessFactor: 0.25 });
  });

  it("never writes vertex colours", () => {
    for (const prim of p.json.meshes[0].primitives) expect(Object.keys(prim.attributes).sort()).toEqual(["NORMAL", "POSITION", "TEXCOORD_0"]);
  });

  it("only the side walls are metal: front, bevel and BACK carry the brand colour", () => {
    // a spinning logo must show its colour from behind, not a grey slab
    const metal = p.json.materials.findIndex((m: { name: string }) => m.name === "metal");
    let metalIdx = 0;
    for (const prim of p.json.meshes[0].primitives) if (prim.material === metal) metalIdx += p.json.accessors[prim.indices].count;
    let sideIdx = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) if (mesh.faceKind[mesh.indices[t]] === FaceKind.Side) sideIdx += 3;
    expect(sideIdx).toBeGreaterThan(0);
    expect(metalIdx).toBe(sideIdx);
  });

  it("keeps every triangle: index count across primitives == mesh.indices.length", () => {
    let total = 0;
    for (const prim of p.json.meshes[0].primitives) total += p.json.accessors[prim.indices].count;
    expect(total).toBe(mesh.indices.length);
    for (const prim of p.json.meshes[0].primitives) expect(p.json.accessors[prim.indices].componentType).toBe(5125);
  });

  it("round-trips the index data: same triangles, regrouped", () => {
    const base = p.binHead + 8;
    const key = (a: number, b: number, c: number) => `${a},${b},${c}`;
    const want = new Map<string, number>();
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const k = key(mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]);
      want.set(k, (want.get(k) ?? 0) + 1);
    }
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    for (const prim of p.json.meshes[0].primitives) {
      const acc = p.json.accessors[prim.indices];
      const at = base + p.json.bufferViews[acc.bufferView].byteOffset + acc.byteOffset;
      for (let i = 0; i < acc.count; i += 3) {
        const k = key(dv.getUint32(at + i * 4, true), dv.getUint32(at + i * 4 + 4, true), dv.getUint32(at + i * 4 + 8, true));
        const n = want.get(k);
        expect(n).toBeGreaterThan(0);
        want.set(k, n! - 1);
      }
    }
    for (const n of want.values()) expect(n).toBe(0);
  });

  it("POSITION min/max are the true bounds", () => {
    const acc = p.json.accessors[p.json.meshes[0].primitives[0].attributes.POSITION];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3)
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], mesh.positions[i + c]);
        max[c] = Math.max(max[c], mesh.positions[i + c]);
      }
    expect(acc.count).toBe(mesh.positions.length / 3);
    expect(acc.min).toEqual(min);
    expect(acc.max).toEqual(max);
  });

  it("is byte-identical across exports", () => {
    expect(Buffer.from(meshToGlb(mesh)).equals(Buffer.from(glb))).toBe(true);
  });

  it("unlit adds KHR_materials_unlit to FRONT materials only", () => {
    const u = parse(meshToGlb(mesh, { unlit: true })).json;
    expect(u.extensionsUsed).toEqual(["KHR_materials_unlit"]);
    for (const m of u.materials) {
      if (m.name.startsWith("front ")) expect(m.extensions).toEqual({ KHR_materials_unlit: {} });
      else expect(m.extensions).toBeUndefined();
    }
    expect(p.json.extensionsUsed).toBeUndefined();
  });

  it("passes the Khronos glTF validator with zero errors", async () => {
    const report = await validateBytes(new Uint8Array(glb));
    const codes = [...new Set(report.issues.messages.filter((m) => m.severity === 1).map((m) => m.code))];
    const infoCodes = [...new Set(report.issues.messages.filter((m) => m.severity === 2).map((m) => m.code))];
    console.log(`wordmark validator: errors=${report.issues.numErrors} warnings=${report.issues.numWarnings} infos=${report.issues.numInfos} warningCodes=[${codes.join(", ")}] infoCodes=[${infoCodes.join(", ")}]`);
    expect(report.issues.numErrors).toBe(0);
  });

  it("passes the validator unlit too", async () => {
    const report = await validateBytes(meshToGlb(mesh, { unlit: true }));
    console.log(`wordmark unlit validator: errors=${report.issues.numErrors} warnings=${report.issues.numWarnings}`);
    expect(report.issues.numErrors).toBe(0);
  });
});

describe("meshToGlb: synthetic", () => {
  it("thickO validates with zero errors", async () => {
    const m: Mesh = buildMesh(FIXTURES.thickO);
    const report = await validateBytes(meshToGlb(m));
    const codes = [...new Set(report.issues.messages.filter((x) => x.severity === 1).map((x) => x.code))];
    console.log(`thickO validator: errors=${report.issues.numErrors} warnings=${report.issues.numWarnings} warningCodes=[${codes.join(", ")}]`);
    expect(report.issues.numErrors).toBe(0);
  });

  it("two-colour layered regions get two FRONT materials and one shared metal", () => {
    const a = FIXTURES.slab[0];
    const m = buildMesh([a, { ...a, hex: "#00AAFF", depth: 0.1 }]);
    const j = parse(meshToGlb(m)).json;
    const names = j.materials.map((x: { name: string }) => x.name);
    expect(names.filter((n: string) => n.startsWith("front "))).toEqual(["front #FF2E9A", "front #00AAFF"]);
    expect(names.filter((n: string) => n === "metal").length).toBe(1);
  });

  it("refuses an empty mesh instead of writing an invalid file", () => {
    expect(() => meshToGlb(buildMesh([]))).toThrow(/empty/);
  });
});
