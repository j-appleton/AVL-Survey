import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  launchBrowser,
  serve,
  surveyStateSnapshot,
  until
} from "./app-test-helpers.mjs";

var ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
var RED = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='red'/%3E%3C/svg%3E";
var GREEN = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='green'/%3E%3C/svg%3E";
var BLUE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='20'%3E%3Crect width='30' height='20' fill='blue'/%3E%3C/svg%3E";

function state(){
  return {
    visit:{client:"Photo tab client",site:"Campus",date:"2026-07-30"},
    log:{},
    rooms:[
      {id:1,d:{name:"Boardroom"}},
      {id:2,d:{name:"Training"}}
    ],
    photos:{
      "2|notes":[BLUE],
      "1|audio":[GREEN,BLUE],
      "log|main":[RED]
    },
    skipped:{},
    ui:{"1|audio":true}
  };
}

async function withPhotosApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:844},
      hasTouch:true
    });
    var page = await context.newPage();
    await page.goto(server.origin + "/", {waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    assert.equal(
      await page.evaluate(function(payload){
        return window.__avl.applyImport(JSON.stringify(payload));
      },state()),
      true
    );
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

test("sticky Photos view follows the canonical manifest without entering survey state", async function(){
  await withPhotosApp(async function(page){
    var before = await surveyStateSnapshot(page);
    await page.locator('[data-app-view="photos"]').click();
    var result = await page.evaluate(async function(){
      var manifest = window.__avl.photoManifest().map(function(entry){
        return entry.key + "|" + entry.bucketIndex;
      });
      var dom = Array.prototype.map.call(
        document.querySelectorAll("[data-photos-view] .photoitem"),
        function(item){
          return item.getAttribute("data-photo-key") + "|" +
            item.getAttribute("data-photo-index");
        }
      );
      var portable = await window.__avl.portableEnvelope();
      window.__avl.snapshot();
      return {
        manifest:manifest,
        dom:dom,
        active:window.__avl.appView(),
        toggleInHeader:!!document.querySelector("header [data-app-view='photos']"),
        headerPosition:getComputedStyle(document.querySelector("header")).position,
        ui:JSON.stringify(window.__avl.S().ui),
        portable:JSON.stringify(portable),
        backup:localStorage.getItem("avl_backup_v1")
      };
    });
    assert.deepEqual(result.dom,result.manifest);
    assert.equal(result.active,"photos");
    assert.equal(result.toggleInHeader,true);
    assert.equal(result.headerPosition,"sticky");
    assert.doesNotMatch(result.ui,/photos-view|appView|currentAppView/);
    assert.doesNotMatch(result.portable,/photos-view|appView|currentAppView/);
    assert.doesNotMatch(result.backup,/photos-view|appView|currentAppView/);
    assert.equal(await surveyStateSnapshot(page),before);
  });
});

test("Photos exposes every room section as a direct capture checklist", async function(){
  await withPhotosApp(async function(page){
    await page.locator('[data-app-view="photos"]').click();
    var result = await page.evaluate(function(){
      var room = document.querySelector('[data-photo-room="1"]');
      return {
        expected:window.__avl.ROOM_SECTIONS.map(function(section){
          return {
            key:"1|" + section.id,
            title:section.title
          };
        }),
        actual:Array.prototype.map.call(
          room.querySelectorAll("[data-photo-group]"),
          function(group){
            return {
              key:group.getAttribute("data-photo-group"),
              title:group.querySelector(".photo-group-title span").textContent
            };
          }
        ),
        directAdds:room.querySelectorAll("[data-photos] [data-addph]").length,
        selectors:document.querySelectorAll("[data-photo-add-select],[data-add-room-photos]").length,
        roomToggle:document.querySelectorAll("[data-photo-room-toggle]").length,
        site:!!document.querySelector('[data-photo-group="log|main"] [data-addph]')
      };
    });
    assert.deepEqual(result.actual,result.expected);
    assert.equal(result.directAdds,result.expected.length);
    assert.equal(result.selectors,0);
    assert.equal(result.roomToggle,0);
    assert.equal(result.site,true);
  });
});

test("recovery notices live only with photos and delete state clears on view switch", async function(){
  await withPhotosApp(async function(page){
    var result = await page.evaluate(async function(){
      window.AVLPhotoStore.addDataUrl = function(){
        return Promise.reject(new Error("force inline recovery"));
      };
      var realSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(){ throw new Error("quota"); };
      try {
        await window.__avl.processPhotoBatchForTest(
          "1|notes",
          [{name:"memory"}],
          function(file,done){
            done("data:image/jpeg;base64,AQ==",{width:10,height:10});
          }
        );
      } finally {
        Storage.prototype.setItem = realSet;
      }
      var surveyNotice = !!document.querySelector("[data-photo-recovery='1|notes']");
      window.__avl.switchAppView("photos");
      var photoNotice = !!document.querySelector("[data-photo-recovery='1|notes']");
      var del = document.querySelector('[data-photos="1|audio"] [data-delph="0"]');
      del.click();
      var armedBefore = del.getAttribute("data-armed");
      window.__avl.switchAppView("survey");
      var armedAfter = document.querySelectorAll(".phdel[data-armed='1']").length;
      return {
        surveyNotice:surveyNotice,
        photoNotice:photoNotice,
        armedBefore:armedBefore,
        armedAfter:armedAfter
      };
    });
    assert.equal(result.surveyNotice,false);
    assert.equal(result.photoNotice,true);
    assert.equal(result.armedBefore,"1");
    assert.equal(result.armedAfter,0);
  });
});

test("viewer navigation and focus restoration work from the Photos view", async function(){
  await withPhotosApp(async function(page){
    await page.locator('[data-app-view="photos"]').click();
    var second = page.locator('[data-photos="1|audio"] [data-viewph]').nth(1);
    await second.click();
    await page.waitForSelector(".phviewer");
    await page.locator("[data-phv-prev]").click();
    await page.locator("[data-phv-close]").click();
    var focused = await page.evaluate(function(){
      var item = document.activeElement &&
        document.activeElement.closest("[data-photo-key][data-photo-index]");
      return item
        ? item.getAttribute("data-photo-key") + "|" + item.getAttribute("data-photo-index")
        : "";
    });
    assert.equal(focused,"1|audio|1");
  });
});

test("capture started from the Photos view writes to the chosen empty section", async function(){
  await withPhotosApp(async function(page){
    await page.locator('[data-app-view="photos"]').click();
    await page.locator('[data-photos="1|dims"] [data-addph]').click();
    var png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLJ9QAAAABJRU5ErkJggg==",
      "base64"
    );
    await page.locator("#filein").setInputFiles({
      name:"dimension.png",
      mimeType:"image/png",
      buffer:png
    });
    await until(async function(){
      return page.evaluate(function(){
        return window.__avl.photoCaptureIdle().then(function(){
          return (window.__avl.S().photos["1|dims"] || []).length === 1;
        });
      });
    });
    assert.equal(
      await page.locator('[data-photos="1|dims"] .photoitem').count(),
      1
    );
    assert.equal(
      await page.evaluate(function(){ return window.__avl.appView(); }),
      "photos"
    );
  });
});

test("an in-flight batch survives a view switch and renders into the current view", async function(){
  await withPhotosApp(async function(page){
    var result = await page.evaluate(async function(){
      var flight = window.__avl.processPhotoBatchForTest(
        "1|notes",
        [{name:"slow"}],
        function(file,done){
          setTimeout(function(){
            done("data:image/jpeg;base64,AQ==",{width:10,height:10});
          },80);
        }
      );
      window.__avl.switchAppView("photos");
      await flight;
      return {
        view:window.__avl.appView(),
        count:window.__avl.S().photos["1|notes"].length,
        visible:document.querySelectorAll('[data-photos="1|notes"] .photoitem').length
      };
    });
    assert.equal(result.view,"photos");
    assert.equal(result.count,1);
    assert.equal(result.visible,1);
  });
});
