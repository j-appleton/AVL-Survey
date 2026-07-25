import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("ambient-light and DISCAS calculations retain their domain thresholds", async function(){
  var server = await serve(ROOT);
  var browser = await launchBrowser();

  try {
    var page = await browser.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });

    var values = await page.evaluate(function(){
      var a = window.__avl;
      return {
        nits:[a.recNits(100),a.recNits(101),a.recNits(300),a.recNits(301),
          a.recNits(600),a.recNits(601),a.recNits(1000),a.recNits(1001)],
        footLamberts:[a.targetFL(50),a.targetFL(51),a.targetFL(150),
          a.targetFL(151),a.targetFL(300),a.targetFL(301)],
        lumens:a.recLumens(300,100,1),
        generalDiagonal:a.minDiag(30,false),
        analyticalDiagonal:a.minDiag(30,true),
        generalDistance:a.maxViewFt(100,false),
        analyticalDistance:a.maxViewFt(100,true)
      };
    });

    assert.deepEqual(values.nits, [350,500,500,700,700,1000,1000,1500]);
    assert.deepEqual(values.footLamberts, [16,25,25,35,35,50]);
    assert.equal(values.lumens, 1454);
    assert.equal(values.generalDiagonal, 123);
    assert.equal(values.analyticalDiagonal, 184);
    assert.ok(Math.abs(values.generalDistance - 24.5145) < 0.0001);
    assert.ok(Math.abs(values.analyticalDistance - 16.343) < 0.0001);

    await page.context().close();
  } finally {
    await browser.close();
    await server.close();
  }
});
