import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve } from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function importRoom(page, data){
  var imported = await page.evaluate(function(roomData){
    return window.__avl.applyImport(JSON.stringify({
      visit:{},
      log:{},
      rooms:[{id:1,d:roomData}],
      photos:{},
      skipped:{},
      ui:{"1|light":true}
    }));
  }, data);
  assert.equal(imported, true);
}

async function withApp(setup, run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();

  try {
    var context = await browser.newContext({serviceWorkers:"block"});
    var page = await context.newPage();
    if(setup) await setup(page);
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

test("brightness guidance uses display-wall lux rather than the room maximum", async function(){
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Basis check",
      lux_disp:"100",
      lux_mid:"800",
      lux_rear:"1200",
      disptype:"Direct-view (LCD / LED)"
    });
    var basisText = await page.locator('[data-calc="1"]').innerText();
    assert.match(basisText, /100 lux at display wall/i);
    assert.match(basisText, /350 nits/i);
    assert.doesNotMatch(basisText, /1500 nits/i);
  });
});

test("projection above 300 lux emits the direct-view or shading warning", async function(){
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Projection warning",
      lux_disp:"301",
      disptype:"Projection",
      scr_diag:"100",
      scr_gain:"1"
    });
    var projectionText = await page.locator('[data-calc="1"]').innerText();
    assert.match(projectionText, /too bright for projection/i);
    assert.match(projectionText, /Specify direct-view LED/i);
  });
});

test("an undersized proposed diagonal is flagged against the furthest seat", async function(){
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Sizing warning",
      lux_disp:"100",
      disptype:"Direct-view (LCD / LED)",
      scr_diag:"100",
      far:"30",
      viewtype:"General viewing"
    });
    var sizingText = await page.locator('[data-calc="1"]').innerText();
    assert.match(sizingText, /123″/i);
    assert.match(sizingText, /100″ is undersized for this room/i);
  });
});

test("storage warnings use localStorage rather than origin-wide estimates", async function(){
  await withApp(async function(page){
    await page.addInitScript(function(){
      if(navigator.storage){
        navigator.storage.estimate = function(){
          return Promise.resolve({usage:1, quota:1000000000});
        };
      }
    });
  }, async function(page){
    var storageText = await page.evaluate(function(){
      localStorage.setItem("test_storage_basis", new Array(1600001).join("x"));
      var html = window.__avl.storageHTML();
      localStorage.removeItem("test_storage_basis");
      var wrap = document.createElement("div");
      wrap.innerHTML = html;
      return wrap.textContent;
    });
    assert.match(storageText, /Over \d+% of the survey storage limit/i);
  });
});

test("the daylight-migration warning fires only when another reading is materially brighter", async function(){
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Daylight migration",
      lux_disp:"100",
      lux_rear:"1200",
      disptype:"Direct-view (LCD / LED)"
    });
    var migrating = await page.locator('[data-calc="1"]').innerText();
    assert.match(migrating, /Room reads up to 1200 lux elsewhere/i);
    assert.match(migrating, /re-check at the worst hour/i);
  });

  /* The threshold is >1.8x AND >150 lux. 200 vs 100 clears the ratio but not
     the absolute gap, so a room that is merely a little uneven must stay quiet
     -- otherwise the warning becomes noise and gets ignored. */
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Evenly lit",
      lux_disp:"100",
      lux_rear:"200",
      disptype:"Direct-view (LCD / LED)"
    });
    var even = await page.locator('[data-calc="1"]').innerText();
    assert.doesNotMatch(even, /lux elsewhere/i);
  });
});

test("the two direct-view brightness warnings stay mutually exclusive", async function(){
  /* These are an if / else-if pair. Collapsing them into two independent ifs
     emits both at once, which reads as contradictory advice. Each case asserts
     the sibling is absent, not just that the right one is present. */
  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Washout",
      lux_disp:"1200",
      disptype:"Direct-view (LCD / LED)"
    });
    var washout = await page.locator('[data-calc="1"]').innerText();
    assert.match(washout, /Over 1000 lux/i);
    assert.match(washout, /wash out/i);
    assert.doesNotMatch(washout, /rated 700 nits or better/i);
  });

  await withApp(null, async function(page){
    await importRoom(page, {
      name:"Bright but usable",
      lux_disp:"800",
      disptype:"Direct-view (LCD / LED)"
    });
    var bright = await page.locator('[data-calc="1"]').innerText();
    assert.match(bright, /rated 700 nits or better/i);
    assert.doesNotMatch(bright, /Over 1000 lux/i);
  });
});

test("destructive actions need two taps and never use a native dialog", async function(){
  /* confirm() is blocked in sandboxed viewers and silently returns false, which
     makes destructive buttons look dead. armConfirm() arms on the first tap and
     acts on the second. The confirm stub records any regression to the native
     dialog even when the two-tap assertions would otherwise still pass. */
  await withApp(async function(page){
    await page.addInitScript(function(){
      window.__confirmCalls = 0;
      window.confirm = function(){ window.__confirmCalls++; return true; };
    });
  }, async function(page){
    await importRoom(page, {name:"Doomed room"});

    var deleteButton = page.locator('[data-delroom="1"]');
    await deleteButton.click();
    var afterFirstTap = await page.evaluate(function(){
      return {
        rooms:window.__avl.S().rooms.length,
        label:document.querySelector('[data-delroom="1"]').textContent,
        confirms:window.__confirmCalls
      };
    });
    assert.equal(afterFirstTap.rooms, 1, "one tap must not delete anything");
    assert.match(afterFirstTap.label, /tap again/i, "the button must arm visibly");
    assert.equal(afterFirstTap.confirms, 0, "no native dialog may be used");

    await page.locator('[data-delroom="1"]').click();
    await page.waitForFunction(function(){ return window.__avl.S().rooms.length === 0; });

    assert.equal(
      await page.evaluate(function(){ return window.__confirmCalls; }),
      0,
      "no native dialog may be used"
    );
  });
});

test("photo thumbnails are inert without mutating the survey (transitional guard)", async function(){
  /* This pins the pre-v1.4 behaviour while the photo markup is restructured.
     The viewer PR must deliberately replace this assertion with "opens the
     viewer without mutating state" rather than treating inertness as permanent. */
  await withApp(async function(page){
    await page.addInitScript(function(){
      window.__confirmCalls = 0;
      window.confirm = function(){ window.__confirmCalls++; return true; };
    });
  }, async function(page){
    var photos = [
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='red'/%3E%3C/svg%3E",
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='green'/%3E%3C/svg%3E",
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='blue'/%3E%3C/svg%3E"
    ];
    var imported = await page.evaluate(function(photoData){
      return window.__avl.applyImport(JSON.stringify({
        visit:{},
        log:{},
        rooms:[{id:1,d:{name:"Photo guard"}}],
        photos:{"1|notes":photoData},
        skipped:{},
        ui:{"1|notes":true}
      }));
    }, photos);
    assert.equal(imported, true);

    var before = await page.evaluate(function(){
      return {
        photos:window.__avl.S().photos["1|notes"].slice(),
        bodyChildren:document.body.children.length
      };
    });

    await page.locator('[data-photos="1|notes"] .ph img').nth(1).click();

    var after = await page.evaluate(function(){
      return {
        photos:window.__avl.S().photos["1|notes"].slice(),
        bodyChildren:document.body.children.length,
        confirms:window.__confirmCalls
      };
    });
    assert.deepEqual(after.photos, before.photos, "thumbnail taps must not alter photo state");
    assert.equal(after.bodyChildren, before.bodyChildren, "the current thumbnail tap must stay inert");
    assert.equal(after.confirms, 0, "thumbnail taps must not invoke a native dialog");
  });
});

test("photo deletion removes exactly the selected image without a native dialog", async function(){
  /* Three visibly distinct images make an off-by-one splice observable: deleting
     green must leave red followed by blue, not merely reduce the count. */
  await withApp(async function(page){
    await page.addInitScript(function(){
      window.__confirmCalls = 0;
      window.confirm = function(){ window.__confirmCalls++; return true; };
    });
  }, async function(page){
    var red = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='red'/%3E%3C/svg%3E";
    var green = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='green'/%3E%3C/svg%3E";
    var blue = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='blue'/%3E%3C/svg%3E";
    var imported = await page.evaluate(function(photoData){
      return window.__avl.applyImport(JSON.stringify({
        visit:{},
        log:{},
        rooms:[{id:1,d:{name:"Delete guard"}}],
        photos:{"1|notes":photoData},
        skipped:{},
        ui:{"1|notes":true}
      }));
    }, [red, green, blue]);
    assert.equal(imported, true);

    await page.locator('[data-photos="1|notes"] [data-delph="1"]').click();
    await page.waitForFunction(function(){
      return window.__avl.S().photos["1|notes"].length === 2;
    });

    var result = await page.evaluate(function(){
      return {
        photos:window.__avl.S().photos["1|notes"].slice(),
        rendered:Array.prototype.map.call(
          document.querySelectorAll('[data-photos="1|notes"] .ph img'),
          function(img){ return img.getAttribute("src"); }
        ),
        confirms:window.__confirmCalls
      };
    });
    assert.deepEqual(result.photos, [red, blue], "deletion must remove green and preserve both neighbours");
    assert.deepEqual(result.rendered, [red, blue], "the rendered strip must match the saved photo order");
    assert.equal(result.confirms, 0, "photo deletion must not invoke a native dialog");
  });
});
