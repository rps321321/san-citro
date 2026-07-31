import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  easeOut,
  easeApple,
  springSnappy,
  transitionOrReduce,
  durationFast,
  durationBase,
} from "./motion.ts";

describe("motion presets (ADR-0016)", () => {
  it("exports desktop easeOut and keeps easeApple as alias", () => {
    assert.deepEqual(easeOut, [0.16, 1, 0.3, 1]);
    assert.equal(easeApple, easeOut);
  });

  it("defines product-purpose durations", () => {
    assert.ok(durationFast < durationBase);
    assert.ok(durationBase < 0.5);
  });

  it("collapses transitions when reduced motion is preferred", () => {
    assert.deepEqual(transitionOrReduce(springSnappy, true), { duration: 0 });
    assert.deepEqual(transitionOrReduce(springSnappy, false), springSnappy);
    assert.deepEqual(transitionOrReduce(springSnappy, null), springSnappy);
  });
});
