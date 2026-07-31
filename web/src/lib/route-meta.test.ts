import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getRouteMeta, ROUTE_META } from "./route-meta";

describe("route-meta (#54)", () => {
  it("covers the five primary shell routes with compact labels", () => {
    assert.equal(getRouteMeta("/search").label, "Search");
    assert.equal(getRouteMeta("/library").label, "Library");
    assert.equal(getRouteMeta("/activity").label, "Activity");
    assert.equal(getRouteMeta("/settings").label, "Settings");
    assert.equal(getRouteMeta("/reader").label, "Reader");
  });

  it("only Reader exposes a back affordance", () => {
    for (const [path, meta] of Object.entries(ROUTE_META)) {
      if (path === "/reader") {
        assert.equal(meta.showBack, true);
        assert.equal(meta.backTo, "/library");
        assert.ok(meta.backLabel);
      } else {
        assert.equal(meta.showBack, undefined);
      }
    }
  });

  it("normalizes trailing slashes and falls back for unknown paths", () => {
    assert.equal(getRouteMeta("/search/").label, "Search");
    assert.equal(getRouteMeta("/library/").label, "Library");
    assert.equal(getRouteMeta("/").label, "Search");
    assert.equal(getRouteMeta("").label, "Search");
    assert.equal(getRouteMeta("/not-a-route").label, "San Citro");
  });
});
