import { chromium } from "playwright-core";
import fs from "node:fs";
// Point this at any Chromium build; SwiftShader is enough to decode and render the mesh.
const EXE = process.env.CHROME ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch({
    executablePath: EXE,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.goto("http://localhost:8080/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.__palRig, null, { timeout: 90000 });
  const meta = await page.evaluate(() => {
    const g = window.__palRig.geometry;
    const m = window.__palRig.material;
    const img = m.map && m.map.image;
    return {
      attrs: Object.keys(g.attributes),
      count: g.attributes.position.count,
      indexed: !!g.index,
      indexCount: g.index ? g.index.count : 0,
      indexType: g.index ? g.index.array.constructor.name : null,
      imgW: img ? img.width : null,
      imgH: img ? img.height : null,
      uvItem: g.attributes.uv.itemSize,
    };
  });
  console.log(JSON.stringify(meta));
  const toB64 = async (expr) =>
    page.evaluate((e) => {
      const arr = eval(e);
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      let s = "";
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH)
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(s);
    }, expr);
  const pos = await toB64("window.__palRig.geometry.attributes.position.array");
  fs.writeFileSync(out + "/pos.bin", Buffer.from(pos, "base64"));
  const uv = await toB64("window.__palRig.geometry.attributes.uv.array");
  fs.writeFileSync(out + "/uv.bin", Buffer.from(uv, "base64"));
  if (meta.indexed) {
    const idx = await toB64("window.__palRig.geometry.index.array");
    fs.writeFileSync(out + "/idx.bin", Buffer.from(idx, "base64"));
  }
  // also dump the decoded albedo as raw RGBA via canvas
  const png = await page.evaluate(() => {
    const img = window.__palRig.material.map.image;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/png");
  });
  fs.writeFileSync(out + "/albedo.png", Buffer.from(png.split(",")[1], "base64"));
  await browser.close();
  console.log("done");
})();
