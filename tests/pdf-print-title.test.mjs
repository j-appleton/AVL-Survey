import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve, until } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("temporary print path names the iOS PDF and restores the app title after failure", async function(){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var page = await browser.newPage();
    await page.addInitScript(function(){
      window.__printedTitles = [];
      window.print = function(){
        window.__printedTitles.push(document.title);
        throw new Error("sandboxed print");
      };
    });
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    await page.evaluate(function(){
      var state = window.__avl.S();
      state.visit.client = "Müller Hall";
      state.visit.site = "Main Campus";
      state.visit.date = "2026-07-30";
    });
    await page.locator("#pdf").click();
    await until(async function(){
      return page.evaluate(function(){ return window.__printedTitles.length === 1; });
    });
    var result = await page.evaluate(function(){
      return {printed:window.__printedTitles[0], restored:document.title};
    });
    assert.equal(
      result.printed,
      "Preplot — Müller Hall — Main Campus — 2026-07-30"
    );
    assert.equal(result.restored,"Preplot");
  } finally {
    await browser.close();
    await server.close();
  }
});
