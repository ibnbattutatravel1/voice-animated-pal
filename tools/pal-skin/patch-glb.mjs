import fs from "node:fs";
const [, , glbIn, imgPath, imageIndex, glbOut] = process.argv;
const b = fs.readFileSync(glbIn);
const total = b.readUInt32LE(8);
let off = 12,
  json = null,
  jsonRange = null,
  bin = null;
while (off < total) {
  const clen = b.readUInt32LE(off),
    ctype = b.readUInt32LE(off + 4);
  if (ctype === 0x4e4f534a) {
    json = JSON.parse(b.slice(off + 8, off + 8 + clen).toString("utf8"));
    jsonRange = [off + 8, clen];
  } else if (ctype === 0x004e4942) {
    bin = b.slice(off + 8, off + 8 + clen);
  }
  off += 8 + clen;
}
const idx = Number(imageIndex);
const newImg = fs.readFileSync(imgPath);
const bvIndex = json.images[idx].bufferView;
// rebuild the binary chunk: every bufferView copied in order, 4-byte aligned
const order = json.bufferViews
  .map((bv, i) => ({ i, bv }))
  .sort((a, b2) => (a.bv.byteOffset || 0) - (b2.bv.byteOffset || 0));
const parts = [];
let cursor = 0;
for (const { i, bv } of order) {
  const data =
    i === bvIndex ? newImg : bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) {
    parts.push(Buffer.alloc(pad));
    cursor += pad;
  }
  bv.byteOffset = cursor;
  bv.byteLength = data.length;
  parts.push(data);
  cursor += data.length;
}
const tailPad = (4 - (cursor % 4)) % 4;
if (tailPad) {
  parts.push(Buffer.alloc(tailPad));
  cursor += tailPad;
}
const newBin = Buffer.concat(parts);
json.buffers[0].byteLength = newBin.length;
let jsonStr = JSON.stringify(json);
while (jsonStr.length % 4 !== 0) jsonStr += " ";
const jsonBuf = Buffer.from(jsonStr, "utf8");
const out = Buffer.alloc(12 + 8 + jsonBuf.length + 8 + newBin.length);
out.writeUInt32LE(0x46546c67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(out.length, 8);
out.writeUInt32LE(jsonBuf.length, 12);
out.writeUInt32LE(0x4e4f534a, 16);
jsonBuf.copy(out, 20);
let p = 20 + jsonBuf.length;
out.writeUInt32LE(newBin.length, p);
out.writeUInt32LE(0x004e4942, p + 4);
newBin.copy(out, p + 8);
fs.writeFileSync(glbOut, out);
console.log(
  `ok: ${glbIn} (${b.length}) -> ${glbOut} (${out.length}); image[${idx}] ${newImg.length} bytes`,
);
