/** Mesh -> GLB (glTF 2.0 binary), hand-rolled, no dependency.
 *
 *  Colour rules are docs/DESIGN.md §6: one FRONT material per region carrying the
 *  exact linear hex in baseColorFactor, no texture, no COLOR_0. The bevel is part
 *  of the face (DESIGN.md §5: one height function), so it shares the FRONT
 *  material, and so does the Back (a spinning logo shows its colour from behind);
 *  only the Side walls share the metal one. `unlit` adds KHR_materials_unlit to the FRONT
 *  materials only — geometry is shared, it is a material switch, not a mesh.
 *
 *  Deterministic: no timestamps, fixed key order, primitives sorted by
 *  (region, class), so the same Mesh is always the same bytes.
 *
 *  ponytail: typed-array bytes are copied as-is, i.e. assumes a little-endian
 *  host (every browser and node target). Swap in DataView writes if that ever lies. */
import { hexToBaseColorFactor } from "./color.js";
import { FaceKind, type Mesh } from "./types.js";

export interface GlbOptions {
  unlit?: boolean;
}

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const FLOAT = 5126;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export function meshToGlb(mesh: Mesh, opts: GlbOptions = {}): Uint8Array {
  const { positions, normals, uvs, indices, faceKind, regionIndex, regionHex } = mesh;
  if (!indices.length) throw new Error("RELIEF: cannot export an empty mesh");
  const nVerts = positions.length / 3;

  // ---- group triangles by (region, class); a triangle's class is its first vertex's
  const groups = new Map<number, number[]>(); // key = region*2 + (0 front | 1 metal)
  for (let t = 0; t < indices.length; t += 3) {
    const v = indices[t];
    const key = regionIndex[v] * 2 + (faceKind[v] === FaceKind.Side ? 1 : 0);
    const g = groups.get(key);
    if (g) g.push(indices[t], indices[t + 1], indices[t + 2]);
    else groups.set(key, [indices[t], indices[t + 1], indices[t + 2]]);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);

  // ---- materials (created in primitive order, so the order is deterministic)
  const materials: object[] = [];
  let metal = -1;
  const primitives = keys.map((key) => {
    let material: number;
    if (key % 2 === 0) {
      const hex = regionHex[key / 2];
      material = materials.length;
      materials.push({
        name: `front ${hex}`,
        pbrMetallicRoughness: { baseColorFactor: hexToBaseColorFactor(hex), metallicFactor: 0, roughnessFactor: 0.5 },
        ...(opts.unlit ? { extensions: { KHR_materials_unlit: {} } } : {}),
      });
    } else {
      if (metal < 0) {
        metal = materials.length;
        materials.push({
          name: "metal",
          pbrMetallicRoughness: { baseColorFactor: [0.75, 0.75, 0.78, 1], metallicFactor: 1, roughnessFactor: 0.25 },
        });
      }
      material = metal;
    }
    return { key, material };
  });

  // ---- binary layout: positions | normals | uvs | indices (all multiples of 4)
  const posBytes = positions.byteLength;
  const nrmBytes = normals.byteLength;
  const uvBytes = uvs.byteLength;
  const idxBytes = indices.length * 4;
  const binLength = posBytes + nrmBytes + uvBytes + idxBytes;
  const bin = new Uint8Array(binLength);
  const asBytes = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  bin.set(asBytes(positions), 0);
  bin.set(asBytes(normals), posBytes);
  bin.set(asBytes(uvs), posBytes + nrmBytes);
  const idxOffset = posBytes + nrmBytes + uvBytes;
  const idxView = new Uint32Array(bin.buffer, idxOffset, indices.length);
  const accessors: object[] = [];

  // accurate POSITION bounds (required by the spec)
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], positions[i + c]);
      max[c] = Math.max(max[c], positions[i + c]);
    }
  accessors.push({ bufferView: 0, componentType: FLOAT, count: nVerts, type: "VEC3", min, max });
  accessors.push({ bufferView: 1, componentType: FLOAT, count: nVerts, type: "VEC3" });
  accessors.push({ bufferView: 2, componentType: FLOAT, count: nVerts, type: "VEC2" });

  let cursor = 0; // in indices
  const meshPrimitives = primitives.map(({ key, material }) => {
    const tris = groups.get(key)!;
    idxView.set(tris, cursor);
    accessors.push({ bufferView: 3, byteOffset: cursor * 4, componentType: UINT, count: tris.length, type: "SCALAR" });
    cursor += tris.length;
    return { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: accessors.length - 1, material, mode: 4 };
  });

  const json = {
    asset: { version: "2.0", generator: "RELIEF" },
    ...(opts.unlit ? { extensionsUsed: ["KHR_materials_unlit"] } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "RELIEF" }],
    meshes: [{ name: "RELIEF", primitives: meshPrimitives }],
    materials,
    accessors,
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: posBytes, byteLength: nrmBytes, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: posBytes + nrmBytes, byteLength: uvBytes, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes, target: ELEMENT_ARRAY_BUFFER },
    ],
    buffers: [{ byteLength: binLength }],
  };

  // ---- container: header | JSON chunk (space-padded) | BIN chunk (zero-padded)
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (binLength % 4)) % 4;
  const jsonChunk = jsonBytes.length + jsonPad;
  const binChunk = binLength + binPad;
  const total = 12 + 8 + jsonChunk + 8 + binChunk;
  const out = new Uint8Array(total); // zero-filled, so BIN padding is already zeros
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunk, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonChunk);
  const binHead = 20 + jsonChunk;
  dv.setUint32(binHead, binChunk, true);
  dv.setUint32(binHead + 4, CHUNK_BIN, true);
  out.set(bin, binHead + 8);
  return out;
}
