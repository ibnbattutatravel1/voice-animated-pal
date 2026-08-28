# Repainting the Pal's muzzle

`public/pal.glb` arrived from an image-to-3D generator, so its albedo is a fragmented
multi-view photogrammetry atlas with the lighting baked in — and with a **smile and a tongue
painted onto the face**. That artwork cannot be animated, and it cannot be erased at runtime
either: a colour-keyed erase removes baked colour but not baked shading, which is exactly what
made the old build look like it had a second layer stuck over the mouth.

So the albedo ships repainted. These scripts are how, and how to redo it if the model is ever
re-exported.

The mouth region is defined geometrically, in the face frame relative to `MOUTH`
(see `src/lib/pal-rig.ts`): an ellipse of semi-axes 0.146 × 0.096 centred at (0, −0.016).
Every triangle touching it is rasterised into UV space — the muzzle lands in about ten separate
atlas islands, so a UV-space bounding box would be useless — and each covered texel is replaced
by a quadratic skin-colour field fitted from the annulus just outside the ellipse, ramped in from
the ellipse edge down to r = 0.62 so the patch has no visible border. Fitting the fill from
_geometry_ rather than diffusing it in UV space is what keeps it honest: the atlas is fragmented,
so texels that neighbour each other in UV frequently sit nowhere near each other on the surface,
and a Laplace fill happily drags the blush — or another view's mouth — into the patch.

```sh
npm run dev                                   # the dump reads the decoded mesh out of the app
node tools/pal-skin/dump-geometry.mjs  <outdir>          # pos.bin, uv.bin, idx.bin, albedo.png
python3 tools/pal-skin/inpaint-skin.py <outdir>          # -> albedo_clean6.png  (needs numpy + pillow)
python3 -c "from PIL import Image; Image.open('<outdir>/albedo_clean6.png').convert('RGB') \
  .save('<outdir>/skin.webp','WEBP',quality=92,method=6)"
node tools/pal-skin/patch-glb.mjs public/pal.glb <outdir>/skin.webp 0 public/pal.glb.new
mv public/pal.glb.new public/pal.glb
```

`dump-geometry.mjs` drives a headless Chromium against the dev server and reads the geometry off
the `__palRig` DEV handle, which is far less trouble than getting the Draco decoder to run under
Node — its CJS export is broken, so `require()` returns `{}` and you need `vm.runInContext`.

`patch-glb.mjs` rewrites the GLB's binary chunk in place, keeping the Draco payload untouched and
fixing up every bufferView offset, so only the one image changes.

**Verify by rendering, not by looking at the atlas.** Hold the pose with
`__palRig.freeze(true)`, move `uMouthC` far away so the procedural mouth early-outs, and confirm
the face is blank. A dark crescent surviving that test means the mask missed an island.
