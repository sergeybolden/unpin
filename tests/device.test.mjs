// The icon for "What it was taken with": phone, camera, drone or app. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceIcon } from "../js/xray.js";

test("Phones get the phone icon", () => {
  for (const m of [{ Make: "Apple", Model: "iPhone 11" }, { Make: "samsung", Model: "SM-S918B" }, { Make: "Google", Model: "Pixel 8" }, { Make: "Sony", Model: "XQ-AT51 Xperia 1 II" }]) {
    assert.equal(deviceIcon(m), "device-mobile", JSON.stringify(m));
  }
});

test("Cameras get the camera icon, Sony cameras included", () => {
  for (const m of [{ Make: "NIKON", Model: "COOLPIX P6000" }, { Make: "Canon", Model: "Canon EOS R6" }, { Make: "SONY", Model: "ILCE-7M4" }, { Make: "FUJIFILM", Model: "X-T5" }, { Make: "GoPro", Model: "HERO12 Black" }, { Make: "DJI", Model: "OsmoPocket3" }]) {
    assert.equal(deviceIcon(m), "camera", JSON.stringify(m));
  }
});

test("DJI drones get the drone icon; software only gets the app icon", () => {
  assert.equal(deviceIcon({ Make: "DJI", Model: "FC3582" }), "drone");
  assert.equal(deviceIcon({ Software: "Adobe Photoshop" }), "app-window");
});
