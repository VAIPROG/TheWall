/** Run: bun tests/extension/formats-template-set.test.ts */
import assert from "node:assert";
import {
  createSet, addLayer, primaryLayer, layerCount, isMultiLayer,
  isAnimated, hasAnimatedLayers, withAuthor, fromSingleImage, summarize,
} from "../../src/formats/shared/template-set";
import type { TemplateLayer } from "../../src/formats/shared/template-model";

const layer = (over: Partial<TemplateLayer> = {}): TemplateLayer => ({
  name: "L", image: ["data:image/png;base64,AA"], x: 1, y: 2, scale: 1,
  width: 4, height: 4, ...over,
});

{
  const s = createSet({ source: { standard: "wall-dev", version: 2, confidence: 1, reason: "tag" } });
  assert.strictEqual(layerCount(s), 0, "empty set");
  assert.strictEqual(primaryLayer(s), null, "no primary");
  addLayer(s, layer());
  addLayer(s, layer({ name: "L2" }));
  assert.strictEqual(layerCount(s), 2, "two layers");
  assert.ok(isMultiLayer(s), "multi-layer");
  assert.strictEqual(primaryLayer(s)!.name, "L", "primary is first");
}

{
  const anim = layer({ animation: { sheet: { frameWidth: 2, frameHeight: 2, frameCount: 4, layout: "grid", order: "row" }, timing: { startTime: 0, defaultFrameMs: 100, looping: true } } });
  assert.ok(isAnimated(anim), "animation present");
  assert.ok(!isAnimated(layer()), "no animation");
  const s = createSet(); addLayer(s, layer()); addLayer(s, anim);
  assert.ok(hasAnimatedLayers(s), "has animated");
}

{
  const s = withAuthor(createSet(), { name: "vai", id: "u1" });
  assert.strictEqual(s.author!.name, "vai", "withAuthor sets author");
}

{
  const s = fromSingleImage("data:image/png;base64,AA", 10, 20, 8, 8);
  assert.strictEqual(layerCount(s), 1, "single image → one layer");
  assert.strictEqual(primaryLayer(s)!.x, 10, "x carried");
  const sum = summarize(s);
  assert.strictEqual(sum.layerCount, 1, "summary count");
  assert.strictEqual(sum.animatedCount, 0, "summary animated");
}

console.log("formats-template-set.test.ts: OK");
