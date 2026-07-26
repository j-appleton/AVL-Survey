import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function photos(){
  return [
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='red'/%3E%3C/svg%3E",
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='green'/%3E%3C/svg%3E",
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='blue'/%3E%3C/svg%3E"
  ];
}

async function withViewer(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:844},
      deviceScaleFactor:2,
      hasTouch:true
    });
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    var imported = await page.evaluate(function(items){
      return window.__avl.applyImport(JSON.stringify({
        visit:{client:"Viewer client"},
        log:{},
        rooms:[{id:1,d:{name:"Photo guard"}}],
        photos:{"1|notes":items},
        skipped:{},
        ui:{"1|notes":true}
      }));
    }, photos());
    assert.equal(imported, true);
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

test("viewer navigates within one section and shows the selected stored source uncropped", async function(){
  await withViewer(async function(page){
    var before = await page.evaluate(function(){ return JSON.stringify(window.__avl.S()); });
    var trigger = page.locator('[data-photos="1|notes"] [data-viewph]').nth(1);
    var selectedSource = await trigger.locator("img").getAttribute("src");
    await trigger.click();

    var opened = await page.evaluate(function(){
      var image = document.querySelector(".phvimage");
      return {
        role:document.querySelector(".phviewer").getAttribute("role"),
        modal:document.querySelector(".phviewer").getAttribute("aria-modal"),
        title:document.querySelector(".phvtitle").textContent,
        count:document.querySelector(".phvtop .phvcount").textContent,
        bottom:document.querySelector("[data-phv-bottom]").textContent,
        src:image.getAttribute("src"),
        fit:getComputedStyle(image).objectFit,
        prevDisabled:document.querySelector("[data-phv-prev]").disabled,
        nextDisabled:document.querySelector("[data-phv-next]").disabled,
        focused:document.activeElement.getAttribute("data-phv-close") !== null
      };
    });
    assert.equal(opened.role, "dialog");
    assert.equal(opened.modal, "true");
    assert.equal(opened.title, "Photo guard \u00b7 Notes & red flags");
    assert.equal(opened.count, "Photo 2 of 3");
    assert.equal(opened.bottom, opened.count);
    assert.equal(opened.src, selectedSource, "the viewer must reuse the thumbnail's exact stored source");
    assert.equal(opened.fit, "contain");
    assert.equal(opened.prevDisabled, false);
    assert.equal(opened.nextDisabled, false);
    assert.equal(opened.focused, true, "the visible close control must receive initial focus");

    await page.locator("[data-phv-next]").click();
    assert.equal(await page.locator(".phvimage").getAttribute("src"), photos()[2]);
    assert.equal(await page.locator(".phvtop .phvcount").textContent(), "Photo 3 of 3");
    assert.equal(await page.locator("[data-phv-next]").isDisabled(), true);

    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator(".phvimage").getAttribute("src"), photos()[1]);
    assert.equal(await page.locator(".phvtop .phvcount").textContent(), "Photo 2 of 3");
    assert.equal(
      await page.evaluate(function(){ return JSON.stringify(window.__avl.S()); }),
      before,
      "viewing and navigation must leave survey state byte-identical"
    );
  });
});

test("viewer cancels armed deletion and restores focus by stable photo coordinates", async function(){
  await withViewer(async function(page){
    var deleteButton = page.locator('[data-photos="1|notes"] [data-delph="1"]');
    await deleteButton.click();
    assert.equal(await deleteButton.getAttribute("data-armed"), "1");

    var trigger = page.locator('[data-photos="1|notes"] [data-viewph]').nth(1);
    await trigger.click();
    assert.equal(
      await page.locator('[data-photos="1|notes"] .phdel[data-armed="1"]').count(),
      0,
      "opening the viewer must cancel every armed photo deletion"
    );

    await page.evaluate(function(){
      var oldTrigger = document.querySelector('[data-photo-key="1|notes"][data-photo-index="1"] [data-viewph]');
      var replacement = oldTrigger.cloneNode(true);
      oldTrigger.parentNode.replaceChild(replacement, oldTrigger);
      window.__oldViewerTrigger = oldTrigger;
    });
    await page.locator("[data-phv-close]").click();

    var restored = await page.evaluate(function(){
      var current = document.querySelector('[data-photo-key="1|notes"][data-photo-index="1"] [data-viewph]');
      return {
        closed:!document.querySelector(".phviewer"),
        currentFocused:document.activeElement === current,
        oldDetached:!window.__oldViewerTrigger.isConnected,
        oldFocused:document.activeElement === window.__oldViewerTrigger
      };
    });
    assert.equal(restored.closed, true);
    assert.equal(restored.currentFocused, true, "focus must return to the re-queried thumbnail");
    assert.equal(restored.oldDetached, true);
    assert.equal(restored.oldFocused, false, "a stale DOM reference must never receive restored focus");
  });
});

test("visible close, backdrop, and Escape all close without losing the page position", async function(){
  await withViewer(async function(page){
    var trigger = page.locator('[data-photos="1|notes"] [data-viewph]').first();
    await trigger.scrollIntoViewIfNeeded();
    var scrollY = await page.evaluate(function(){ return window.scrollY; });
    await trigger.click();

    var locked = await page.evaluate(function(){
      return {
        position:document.body.style.position,
        top:document.body.style.top
      };
    });
    assert.equal(locked.position, "fixed");
    assert.equal(locked.top, "-" + scrollY + "px");

    await page.locator("[data-phv-close]").click();
    assert.equal(await page.locator(".phviewer").count(), 0);
    assert.equal(await page.evaluate(function(){ return window.scrollY; }), scrollY);

    await trigger.click();
    await page.locator("[data-phv-backdrop]").click({position:{x:5,y:5}});
    assert.equal(await page.locator(".phviewer").count(), 0, "tapping the backdrop must close");

    await trigger.click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".phviewer").count(), 0, "Escape must close on desktop");
    assert.equal(await page.evaluate(function(){ return window.scrollY; }), scrollY);
  });
});
