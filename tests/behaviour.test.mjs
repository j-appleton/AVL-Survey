import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser, serve, surveyStateSnapshot, until } from "./app-test-helpers.mjs";

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

function distinctPhotos(){
  return [
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='red'/%3E%3C/svg%3E",
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='green'/%3E%3C/svg%3E",
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='blue'/%3E%3C/svg%3E"
  ];
}

async function importPhotos(page, name){
  var photos = distinctPhotos();
  var imported = await page.evaluate(function(payload){
    return window.__avl.applyImport(JSON.stringify({
      visit:{},
      log:{},
      rooms:[{id:1,d:{name:payload.name}}],
      photos:{"1|notes":payload.photos},
      skipped:{},
      ui:{"1|notes":true}
    }));
  }, {name:name, photos:photos});
  assert.equal(imported, true);
  return photos;
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

test("chips preserve a legacy string when a second option is selected", async function(){
  await withApp(null, async function(page){
    var imported = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{},
        log:{},
        rooms:[{id:1,d:{name:"Legacy control",ctrl:"Touch panel"}}],
        photos:{},
        skipped:{},
        ui:{"1|exist":true}
      }));
    });
    assert.equal(imported, true);

    var control = page.locator('[data-scope="1"][data-k="ctrl"]');
    assert.equal(
      await control.locator('[data-chip][data-v="Touch panel"]').getAttribute("aria-pressed"),
      "true",
      "the existing string must render as selected"
    );

    await control.locator('[data-chip][data-v="App / BYOD"]').click();
    assert.deepEqual(
      await page.evaluate(function(){ return window.__avl.S().rooms[0].d.ctrl; }),
      ["Touch panel","App / BYOD"],
      "the first chip tap must preserve and normalize the existing answer"
    );
  });
});

test("array-valued chips render, deselect and extend normally", async function(){
  await withApp(null, async function(page){
    var imported = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{},
        log:{},
        rooms:[{id:1,d:{name:"Array chips",wall:["Drywall","Glass"]}}],
        photos:{},
        skipped:{},
        ui:{"1|dims":true}
      }));
    });
    assert.equal(imported, true);

    var walls = page.locator('[data-scope="1"][data-k="wall"]');
    assert.equal(
      await walls.locator('[data-chip][data-v="Drywall"]').getAttribute("aria-pressed"),
      "true"
    );
    assert.equal(
      await walls.locator('[data-chip][data-v="Glass"]').getAttribute("aria-pressed"),
      "true"
    );
    assert.equal(
      await walls.locator('[data-chip][data-v="Concrete"]').getAttribute("aria-pressed"),
      "false"
    );

    await walls.locator('[data-chip][data-v="Glass"]').click();
    assert.deepEqual(
      await page.evaluate(function(){
        return window.__avl.S().rooms[0].d.wall;
      }),
      ["Drywall"]
    );
    assert.equal(
      await walls.locator('[data-chip][data-v="Drywall"]').getAttribute("aria-pressed"),
      "true"
    );
    assert.equal(
      await walls.locator('[data-chip][data-v="Glass"]').getAttribute("aria-pressed"),
      "false"
    );

    await walls.locator('[data-chip][data-v="Concrete"]').click();
    assert.deepEqual(
      await page.evaluate(function(){
        return window.__avl.S().rooms[0].d.wall;
      }),
      ["Drywall","Concrete"]
    );
  });
});

test("rendering a legacy chip string leaves the stored value untouched", async function(){
  await withApp(null, async function(page){
    var imported = await page.evaluate(function(){
      return window.__avl.applyImport(JSON.stringify({
        visit:{},
        log:{},
        rooms:[{id:1,d:{name:"Legacy rendering",ctrl:"Touch panel"}}],
        photos:{},
        skipped:{},
        ui:{"1|exist":true,"1|dims":true}
      }));
    });
    assert.equal(imported, true);

    async function storedControl(){
      return page.evaluate(function(){
        var value = window.__avl.S().rooms[0].d.ctrl;
        return {
          value:value,
          type:Array.isArray(value) ? "array" : typeof value
        };
      });
    }

    assert.deepEqual(
      await storedControl(),
      {value:"Touch panel",type:"string"}
    );

    await page.locator('[data-skip="1|dims"]').click();
    assert.deepEqual(
      await storedControl(),
      {value:"Touch panel",type:"string"}
    );

    await page.locator(
      '[data-scope="1"][data-k="ctrl"] [data-chip][data-v="App / BYOD"]'
    ).click();
    assert.deepEqual(
      await storedControl(),
      {value:["Touch panel","App / BYOD"],type:"array"}
    );
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

test("photo thumbnails open the stored image without mutating the survey", async function(){
  await withApp(async function(page){
    await page.addInitScript(function(){
      window.__confirmCalls = 0;
      window.confirm = function(){ window.__confirmCalls++; return true; };
    });
  }, async function(page){
    await importPhotos(page, "Photo guard");

    var before = await surveyStateSnapshot(page);
    await page.waitForFunction(function(){
      var image = document.querySelector('[data-photos="1|notes"] .ph img:nth-of-type(1)');
      return image && /^blob:/.test(image.getAttribute("src") || "");
    });
    var selectedSource = await page.locator('[data-photos="1|notes"] .ph img').nth(1).getAttribute("src");

    await page.locator('[data-photos="1|notes"] .ph img').nth(1).click();
    await page.waitForFunction(function(expected){
      var image = document.querySelector(".phvimage");
      return image && image.getAttribute("src") === expected;
    }, selectedSource);

    var after = await page.evaluate(function(){
      var viewer = document.querySelector(".phviewer");
      var image = viewer.querySelector(".phvimage");
      return {
        dialog:viewer.getAttribute("role"),
        modal:viewer.getAttribute("aria-modal"),
        src:image.getAttribute("src"),
        fit:getComputedStyle(image).objectFit,
        confirms:window.__confirmCalls
      };
    });
    assert.equal(await surveyStateSnapshot(page), before, "opening the viewer must not alter survey state");
    assert.equal(after.dialog, "dialog");
    assert.equal(after.modal, "true");
    assert.match(after.src, /^blob:/, "stored photo bytes must render through an object URL");
    assert.equal(after.src, selectedSource, "the viewer must use the selected thumbnail's hydrated source");
    assert.equal(after.fit, "contain", "the stored image must be shown uncropped");
    assert.equal(after.confirms, 0, "thumbnail taps must not invoke a native dialog");
  });
});

test("photo hydration fills placeholders in place without re-rendering the survey", async function(){
  await withApp(async function(page){
    await page.addInitScript(function(){
      var realSetTimeout = window.setTimeout.bind(window);
      window.__photoHydrationTimers = [];
      window.setTimeout = function(fn,delay){
        if(delay === 0){
          window.__photoHydrationTimers.push(fn);
          return -1000 - window.__photoHydrationTimers.length;
        }
        return realSetTimeout(fn,delay);
      };
    });
  }, async function(page){
    await importPhotos(page,"Hydration guard");
    var pending = await page.evaluate(function(){
      var items = Array.prototype.slice.call(document.querySelectorAll('[data-photos="1|notes"] .photoitem'));
      window.__photoPlaceholderItems = items;
      return {
        timers:window.__photoHydrationTimers.length,
        sources:items.map(function(item){ return item.querySelector("img").getAttribute("src"); }),
        loading:items.map(function(item){ return item.querySelector(".phload").textContent; })
      };
    });
    assert.equal(pending.timers,3);
    assert.deepEqual(pending.sources,[null,null,null]);
    assert.deepEqual(pending.loading,["Loading photo","Loading photo","Loading photo"]);

    await page.evaluate(function(){
      var timers = window.__photoHydrationTimers.splice(0);
      timers.forEach(function(fn){ fn(); });
    });
    await page.waitForFunction(function(){
      return Array.prototype.every.call(
        document.querySelectorAll('[data-photos="1|notes"] .ph img'),
        function(image){ return /^blob:/.test(image.getAttribute("src") || ""); }
      );
    });
    var hydrated = await page.evaluate(function(){
      var items = Array.prototype.slice.call(document.querySelectorAll('[data-photos="1|notes"] .photoitem'));
      return {
        sameNodes:items.every(function(item,index){ return item === window.__photoPlaceholderItems[index]; }),
        ready:items.every(function(item){ return item.querySelector("[data-viewph]").classList.contains("ready"); })
      };
    });
    assert.equal(hydrated.sameNodes,true,"hydration must update the existing thumbnails, not re-render the app");
    assert.equal(hydrated.ready,true);
  });
});

/* The PR's stated safety mechanism is that a cache entry retains its source, so
   a shifted index cannot hand back the previous photo's Blob. Today that is
   belt-and-braces with reconcilePhotoAssets() at render, but the belt itself was
   untested and B2 makes materialisation a real IndexedDB round-trip, which
   weakens the render coupling that is currently covering for it. */
test("a shifted index never resolves to the previous photo's Blob", async function(){
  await withApp(null, async function(page){
    var photos = await importPhotos(page,"Index shift");

    var result = await page.evaluate(async function(sources){
      function bytesOf(dataUrl){
        var payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
        var text = dataUrl.indexOf(";base64,") > -1 ? atob(payload) : decodeURIComponent(payload);
        var out = [];
        for(var i=0;i<text.length;i++) out.push(text.charCodeAt(i));
        return out;
      }
      async function bytesBehind(key,index){
        var loaded = await window.__avl.hydratePhotoSource(key,index);
        var buffer = await loaded.blob.arrayBuffer();
        return Array.prototype.slice.call(new Uint8Array(buffer));
      }

      /* hydrate every photo so a stale entry exists at each token */
      await bytesBehind("1|notes",0);
      await bytesBehind("1|notes",1);
      await bytesBehind("1|notes",2);

      /* shift indices without an intervening render, which is the state B2
         reaches whenever hydration outlives the render that started it */
      window.__avl.S().photos["1|notes"].splice(0,1);

      return {
        atZero:await bytesBehind("1|notes",0),
        atOne:await bytesBehind("1|notes",1),
        expectedZero:bytesOf(sources[1]),
        expectedOne:bytesOf(sources[2]),
        removed:bytesOf(sources[0])
      };
    }, photos);

    assert.deepEqual(result.atZero,result.expectedZero,
      "index 0 must resolve to the photo that shifted into it");
    assert.notDeepEqual(result.atZero,result.removed,
      "index 0 must never resolve to the deleted photo's Blob");
    assert.deepEqual(result.atOne,result.expectedOne,
      "index 1 must resolve to the photo that shifted into it");
  });
});

/* The print sheet is a photo consumer like any other. Under schema 3 there will
   be no data URL to embed, so a regression here fails outright rather than
   quietly shipping megabytes of base64 into the print DOM. */
test("the print sheet renders photos through the seam rather than embedding data URLs", async function(){
  await withApp(async function(page){
    await page.addInitScript(function(){
      window.__printCalls = 0;
      window.print = function(){ window.__printCalls++; };
    });
  }, async function(page){
    await importPhotos(page,"Print seam");
    await page.locator("#pdf").click();
    await until(async function(){
      return page.evaluate(function(){ return window.__printCalls > 0; });
    });
    var printed = await page.evaluate(function(){
      var html = document.getElementById("print").innerHTML;
      return {
        dataUrls:(html.match(/src="data:/g) || []).length,
        blobUrls:(html.match(/src="blob:/g) || []).length
      };
    });
    assert.equal(printed.dataUrls,0,"the print sheet must not embed data URLs");
    assert.equal(printed.blobUrls,3,"every photo must print through an object URL");
  });
});

test("object URLs survive an open viewer, revoke after deletion closes, and clear on pagehide", async function(){
  await withApp(async function(page){
    await page.addInitScript(function(){
      window.__photoObjectUrls = [];
      window.__photoRevokedUrls = [];
      URL.createObjectURL = function(){
        var value = "blob:photo-asset-" + (window.__photoObjectUrls.length + 1);
        window.__photoObjectUrls.push(value);
        return value;
      };
      URL.revokeObjectURL = function(value){
        window.__photoRevokedUrls.push(value);
      };
    });
  }, async function(page){
    await importPhotos(page,"URL lifecycle");
    await page.waitForFunction(function(){ return window.__avl.photoAssetStatus().length === 3; });
    await page.locator('[data-photos="1|notes"] [data-viewph]').first().click();
    await page.waitForFunction(function(){
      var button = document.querySelector("[data-phv-save]");
      return button && !button.disabled;
    });
    var heldUrl = await page.locator(".phvimage").getAttribute("src");

    var during = await page.evaluate(function(){
      var button = document.querySelector('[data-photos="1|notes"] [data-delph="0"]');
      button.click();
      button.click();
      return {
        count:window.__avl.S().photos["1|notes"].length,
        revoked:window.__photoRevokedUrls.slice()
      };
    });
    assert.equal(during.count,2);
    assert.equal(
      during.revoked.indexOf(heldUrl),
      -1,
      "an object URL held by the open viewer must survive removal from survey state"
    );

    await page.locator("[data-phv-close]").click();
    assert.equal(
      await page.evaluate(function(url){ return window.__photoRevokedUrls.indexOf(url) > -1; }, heldUrl),
      true,
      "the removed photo's URL must revoke once the viewer releases it"
    );
    await page.waitForFunction(function(){ return window.__avl.photoAssetStatus().length === 2; });
    var liveUrls = await page.evaluate(function(){
      return window.__avl.photoAssetStatus().map(function(asset){ return asset.url; });
    });
    await page.evaluate(function(){ window.dispatchEvent(new Event("pagehide")); });
    var revoked = await page.evaluate(function(){ return window.__photoRevokedUrls.slice(); });
    liveUrls.forEach(function(url){
      assert.ok(revoked.indexOf(url) > -1,"pagehide must revoke every live photo URL");
    });
  });
});

test("photo controls are siblings and two taps delete only the armed image", async function(){
  /* Three visibly distinct images make positional mistakes observable. Arming
     green, switching the arm to red, then deleting red must leave green + blue
     and a fresh unarmed render. */
  await withApp(async function(page){
    await page.addInitScript(function(){
      window.__confirmCalls = 0;
      window.confirm = function(){ window.__confirmCalls++; return true; };
    });
  }, async function(page){
    var photos = await importPhotos(page, "Delete guard");

    var structure = await page.evaluate(function(){
      var strip = document.querySelector('[data-photos="1|notes"]');
      var items = Array.prototype.filter.call(strip.children, function(child){
        return child.classList.contains("photoitem");
      });
      return {
        itemCount:items.length,
        lastIsAdd:strip.lastElementChild.classList.contains("addph"),
        nestedButtons:strip.querySelectorAll(".ph button, button button").length,
        items:items.map(function(item){
          return {
            overflow:getComputedStyle(item).overflow,
            previewTag:item.children[0] && item.children[0].tagName,
            previewClass:item.children[0] && item.children[0].className,
            previewIsPh:item.children[0] && item.children[0].classList.contains("ph"),
            deleteTag:item.children[1] && item.children[1].tagName,
            deleteClass:item.children[1] && item.children[1].className,
            deleteDirect:item.children[1] && item.children[1].parentNode === item
          };
        }),
        labels:Array.prototype.map.call(strip.querySelectorAll("[data-delph]"), function(btn){
          return btn.getAttribute("aria-label");
        })
      };
    });
    assert.equal(structure.itemCount, 3);
    assert.equal(structure.lastIsAdd, true, "Add Photo must remain last in the strip");
    assert.equal(structure.nestedButtons, 0, "photo controls must never be nested buttons");
    structure.items.forEach(function(item){
      assert.equal(item.overflow, "visible", "the positioned wrapper must remain clip-free");
      assert.equal(item.previewTag, "BUTTON", "the thumbnail must be a real activatable control");
      assert.equal(item.previewIsPh, true);
      assert.equal(item.deleteTag, "BUTTON");
      assert.equal(item.deleteClass, "phdel");
      assert.equal(item.deleteDirect, true, "thumbnail and delete control must be siblings");
    });
    assert.deepEqual(structure.labels, [
      "Delete photo 1 of 3",
      "Delete photo 2 of 3",
      "Delete photo 3 of 3"
    ]);

    var green = page.locator('[data-photos="1|notes"] [data-delph="1"]');
    var greenBefore = await green.evaluate(function(btn){
      return {
        width:btn.getBoundingClientRect().width,
        background:getComputedStyle(btn).backgroundColor
      };
    });
    await green.click();

    var greenArmed = await page.evaluate(function(){
      var btn = document.querySelector('[data-photos="1|notes"] [data-delph="1"]');
      var item = btn.parentNode.getBoundingClientRect();
      var box = btn.getBoundingClientRect();
      return {
        photos:window.__avl.S().photos["1|notes"].slice(),
        armed:btn.getAttribute("data-armed"),
        text:btn.textContent,
        label:btn.getAttribute("aria-label"),
        width:box.width,
        background:getComputedStyle(btn).backgroundColor,
        contained:box.left >= item.left && box.right <= item.right
      };
    });
    assert.deepEqual(greenArmed.photos, photos, "the first tap must not delete anything");
    assert.equal(greenArmed.armed, "1");
    assert.equal(greenArmed.text, "Delete?");
    assert.equal(greenArmed.label, "Tap again to delete photo 2 of 3");
    assert.ok(greenArmed.width > greenBefore.width, "the armed icon must expand visibly");
    assert.notEqual(greenArmed.background, greenBefore.background, "the armed state must change colour");
    assert.equal(greenArmed.contained, true, "the armed pill must stay inside its 76px tile");

    var red = page.locator('[data-photos="1|notes"] [data-delph="0"]');
    await red.click();
    var switched = await page.evaluate(function(){
      return {
        photos:window.__avl.S().photos["1|notes"].slice(),
        armed:Array.prototype.map.call(
          document.querySelectorAll('[data-photos="1|notes"] .phdel[data-armed="1"]'),
          function(btn){ return btn.getAttribute("data-delph"); }
        ),
        greenLabel:document.querySelector('[data-photos="1|notes"] [data-delph="1"]').getAttribute("aria-label"),
        redLabel:document.querySelector('[data-photos="1|notes"] [data-delph="0"]').getAttribute("aria-label")
      };
    });
    assert.deepEqual(switched.photos, photos, "switching the armed photo must not delete anything");
    assert.deepEqual(switched.armed, ["0"], "only one photo delete may remain armed");
    assert.equal(switched.greenLabel, "Delete photo 2 of 3", "the previous control must fully reset");
    assert.equal(switched.redLabel, "Tap again to delete photo 1 of 3");

    await red.click();
    await page.waitForFunction(function(){
      var images = document.querySelectorAll('[data-photos="1|notes"] .ph img[src^="blob:"]');
      return window.__avl.S().photos["1|notes"].length === 2 && images.length === 2;
    }, null, {timeout:2000});

    var result = await page.evaluate(function(){
      var strip = document.querySelector('[data-photos="1|notes"]');
      return {
        photos:window.__avl.S().photos["1|notes"].slice(),
        rendered:Array.prototype.map.call(
          strip.querySelectorAll(".ph img"),
          function(img){ return img.getAttribute("src"); }
        ),
        assets:window.__avl.photoAssetStatus(),
        armed:strip.querySelectorAll('.phdel[data-armed="1"]').length,
        labels:Array.prototype.map.call(strip.querySelectorAll("[data-delph]"), function(btn){
          return btn.getAttribute("aria-label");
        }),
        lastIsAdd:strip.lastElementChild.classList.contains("addph"),
        confirms:window.__confirmCalls
      };
    });
    assert.deepEqual(result.photos, [photos[1], photos[2]], "deletion must remove red and preserve green + blue");
    assert.equal(result.rendered.length, 2);
    result.rendered.forEach(function(url){ assert.match(url, /^blob:/); });
    assert.deepEqual(
      result.rendered,
      result.assets.map(function(asset){ return asset.url; }),
      "the rendered strip must follow the hydrated asset order"
    );
    assert.deepEqual(
      result.assets.map(function(asset){ return asset.source; }),
      [photos[1],photos[2]],
      "index shifts must not attach a deleted photo's Blob to its neighbour"
    );
    assert.equal(result.armed, 0, "the deletion render must clear every armed state");
    assert.deepEqual(result.labels, ["Delete photo 1 of 2", "Delete photo 2 of 2"]);
    assert.equal(result.lastIsAdd, true, "Add Photo must remain last after re-render");
    assert.equal(result.confirms, 0, "photo deletion must not invoke a native dialog");
  });
});

test("photo delete arming expires without deleting", async function(){
  await withApp(async function(page){
    await page.addInitScript(function(){
      var realSetTimeout = window.setTimeout.bind(window);
      var realClearTimeout = window.clearTimeout.bind(window);
      window.__confirmCalls = 0;
      window.__photoArmTimers = [];
      window.__nextPhotoArmTimer = -9000;
      window.confirm = function(){ window.__confirmCalls++; return true; };
      window.setTimeout = function(fn, delay){
        if(delay === 3500){
          var timer = {
            id:window.__nextPhotoArmTimer--,
            fn:fn,
            cancelled:false
          };
          window.__photoArmTimers.push(timer);
          return timer.id;
        }
        return realSetTimeout(fn, delay);
      };
      window.clearTimeout = function(id){
        var timer = window.__photoArmTimers.filter(function(item){ return item.id === id; })[0];
        if(timer){
          timer.cancelled = true;
          return;
        }
        return realClearTimeout(id);
      };
    });
  }, async function(page){
    var photos = await importPhotos(page, "Timeout guard");
    var blue = page.locator('[data-photos="1|notes"] [data-delph="2"]');
    await blue.click();

    assert.equal(
      await page.evaluate(function(){ return window.__photoArmTimers.length; }),
      1,
      "arming must schedule a reset"
    );
    await page.evaluate(function(){
      var timer = window.__photoArmTimers[0];
      if(!timer.cancelled) timer.fn();
    });

    var result = await page.evaluate(function(){
      var btn = document.querySelector('[data-photos="1|notes"] [data-delph="2"]');
      return {
        photos:window.__avl.S().photos["1|notes"].slice(),
        armed:btn.hasAttribute("data-armed"),
        text:btn.textContent,
        label:btn.getAttribute("aria-label"),
        confirms:window.__confirmCalls
      };
    });
    assert.deepEqual(result.photos, photos, "expiry must not delete anything");
    assert.equal(result.armed, false);
    assert.equal(result.text, "\u00d7");
    assert.equal(result.label, "Delete photo 3 of 3");
    assert.equal(result.confirms, 0);

    await page.locator('[data-photos="1|notes"] [data-delph="1"]').click();
    await page.locator('[data-photos="1|notes"] [data-delph="0"]').click();
    await page.locator('[data-photos="1|notes"] [data-delph="1"]').click();
    var switched = await page.evaluate(function(){
      return {
        cancelled:window.__photoArmTimers.map(function(timer){ return timer.cancelled; }),
        armed:Array.prototype.map.call(
          document.querySelectorAll('[data-photos="1|notes"] .phdel[data-armed="1"]'),
          function(btn){ return btn.getAttribute("data-delph"); }
        )
      };
    });
    assert.deepEqual(
      switched.cancelled,
      [true, true, true, false],
      "resetting or switching a control must cancel every superseded timer"
    );
    assert.deepEqual(switched.armed, ["1"], "only the most recently armed photo may remain active");
  });
});
