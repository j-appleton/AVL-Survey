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

async function withApp(run){
  var server = await serve(ROOT);
  var browser = await launchBrowser();
  try {
    var context = await browser.newContext({
      serviceWorkers:"block",
      viewport:{width:390,height:700},
      hasTouch:true
    });
    var page = await context.newPage();
    await page.goto(server.origin + "/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(function(){ return !!window.__avl; });
    await page.evaluate(async function(){
      var rooms = [
        {id:1,d:{name:"Sanctuary"}},
        {id:2,d:{name:"Conference Hall"}},
        {id:3,d:{name:"Network Room"}}
      ];
      var photos = {};
      for(var r=0;r<rooms.length;r++){
        var key = rooms[r].id + "|audio";
        photos[key] = [];
        for(var p=0;p<4;p++){
          var record = await window.AVLPhotoStore.addDataUrl(
            "data:image/jpeg;base64,AQ==",30 + p,20 + p
          );
          photos[key].push({
            id:record.id,mime:record.mime,bytes:record.bytes,
            width:record.width,height:record.height
          });
        }
      }
      var ui = {};
      rooms.forEach(function(room){
        window.__avl.ROOM_SECTIONS.forEach(function(section){
          ui[room.id + "|" + section.id] = true;
        });
      });
      await window.__avl.setDescriptorStateForTest({
        visit:{client:"Room context client",site:"Three-building campus",date:"2026-08-13"},
        log:{},rooms:rooms,photos:photos,captions:{},compose:{summary:"",excluded:{}},
        skipped:{},ui:ui,meta:{created:"old",updated:"old",app:"1.22.5"}
      });
    });
    await run(page);
    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

async function scrollToAndExpect(page,selector,roomId,label){
  await page.locator(selector).evaluate(function(element){
    element.scrollIntoView({block:"start"});
  });
  await until(async function(){
    return page.evaluate(function(expected){
      var pill = document.querySelector("[data-room-context-pill]");
      return pill && pill.getAttribute("data-active-room") === expected;
    },String(roomId));
  });
  var result = await page.locator("[data-room-context-pill]").evaluate(function(pill){
    return {
      text:pill.textContent,
      label:pill.getAttribute("aria-label"),
      active:pill.getAttribute("data-active-room")
    };
  });
  assert.deepEqual(result,{
    text:label,
    label:"Current room: " + label,
    active:String(roomId)
  });
}

test("the left room pill follows the active room across every app view", async function(){
  await withApp(async function(page){
    var before = await surveyStateSnapshot(page);
    var initial = await page.locator("[data-room-context-pill]").evaluate(function(pill){
      var style = getComputedStyle(pill);
      var matrix = new DOMMatrix(style.transform);
      var rail = pill.parentNode.getBoundingClientRect();
      var pillBox = pill.getBoundingClientRect();
      var firstCard = document.querySelector("#app .card").getBoundingClientRect();
      return {
        position:getComputedStyle(pill.parentNode).position,
        rotation:Math.round(matrix.b),
        railWidth:rail.width,
        pillWidth:pillBox.width,
        pillHeight:pillBox.height,
        fontSize:parseFloat(style.fontSize),
        background:style.backgroundColor,
        railRight:rail.right,
        contentLeft:firstCard.left,
        active:pill.getAttribute("data-active-room")
      };
    });
    assert.equal(initial.position,"fixed","the room pill must ride with the viewport");
    assert.equal(initial.rotation,-1,"letter tops must face the left edge");
    assert.ok(initial.railWidth >= 44,"the room rail must be visually substantial");
    assert.ok(initial.pillWidth >= 40,"the rotated pill must remain thick enough to read");
    assert.ok(initial.pillHeight >= 250,"the pill must not collapse to icon size before rotation");
    assert.ok(initial.fontSize >= 14,"the room name must remain legible");
    assert.notEqual(initial.background,"rgba(0, 0, 0, 0)","the active-room pill needs a solid fill");
    assert.ok(initial.railRight <= initial.contentLeft,"the pill must not cover the working area");
    assert.equal(initial.active,"site");

    await scrollToAndExpect(page,'[data-room="2"]',2,"Conference Hall");

    await page.locator('[data-app-view="photos"]').click();
    await scrollToAndExpect(page,'[data-photo-room="3"]',3,"Network Room");

    await page.locator('[data-app-view="compose"]').click();
    await scrollToAndExpect(page,'.compose-room-marker[data-room-id="1"]',1,"Sanctuary");

    assert.equal(await surveyStateSnapshot(page),before,"room tracking must remain ephemeral UI state");
  });
});

test("the active room pill follows a room rename immediately", async function(){
  await withApp(async function(page){
    await scrollToAndExpect(page,'[data-room="2"]',2,"Conference Hall");
    var name = page.locator('[data-room="2"] [data-k="name"]');
    await name.fill("Chapel Annex");
    await until(async function(){
      return (await page.locator("[data-room-context-pill]").textContent()) === "Chapel Annex";
    });
    assert.equal(
      await page.locator("[data-room-context-pill]").getAttribute("aria-label"),
      "Current room: Chapel Annex"
    );
  });
});
