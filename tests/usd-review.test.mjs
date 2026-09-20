import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {launchBrowser,serve,surveyStateSnapshot,until} from "./app-test-helpers.mjs";

const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE=join(ROOT,"tests/fixtures/usd-room-scan.usd");
const context={TextDecoder,ArrayBuffer,DataView,Uint8Array};
vm.createContext(context);
for(const name of ["usd-import.js","usd-scene.js"]) vm.runInContext(readFileSync(join(ROOT,name),"utf8"),context);
const clean=value=>JSON.parse(JSON.stringify(value));
const scene=()=>context.PrePlotUSD.parse(readFileSync(FIXTURE));

test("USD geometry composes transforms and reports whole-model bounds without assuming units",()=>{
  const summary=context.PrePlotUSDScene.summarize(scene());
  assert.deepEqual(clean(summary.bounds),{min:[10,0,20],max:[14,3,25]});
  assert.deepEqual(clean(summary.counts),{Wall:2,Floor:1});
  assert.equal(summary.areas.length,1);
  assert.deepEqual(clean(summary.areas[0].position),[12,0,22.5]);
  assert.equal(summary.areas[0].name,"Conference room");
  assert.throws(()=>context.PrePlotUSDScene.dimensions(summary,null),/Choose the scan units/);
  const dims=context.PrePlotUSDScene.dimensions(summary,1);
  assert.ok(Math.abs(dims.x-4/0.3048)<1e-9);
  assert.ok(Math.abs(dims.z-5/0.3048)<1e-9);
  assert.ok(Math.abs(dims.height-3/0.3048)<1e-9);
  const feet=context.PrePlotUSDScene.dimensions(summary,0.3048);
  assert.deepEqual(clean(feet),{x:4,y:3,z:5,height:3});
});

test("USD geometry rejects invalid topology and transforms, respects inactive subtrees and reset stacks",()=>{
  const source=scene();
  const mesh=source.prims.find(p=>p.type==="Mesh");
  mesh.attributes.faceVertexIndices[0]=999;
  assert.throws(()=>context.PrePlotUSDScene.summarize(source),/point index/);
  const rotation=scene();
  rotation.prims[0].attributes.xformOpOrder=["xformOp:rotateXYZ"];
  assert.throws(()=>context.PrePlotUSDScene.summarize(rotation),/Unsupported scan transform/);
  const inactive=scene();
  inactive.prims.find(p=>p.path.endsWith("/Arch_grp")).metadata.active=false;
  const floor=context.PrePlotUSDScene.summarize(inactive);
  assert.equal(floor.meshes.length,1);
  assert.equal(floor.bounds.max[1],0);
  const reset=scene();
  const area=reset.prims.find(p=>p.path.endsWith("/conferenceRoom0"));
  area.attributes.xformOpOrder.unshift("!resetXformStack!");
  assert.deepEqual(clean(context.PrePlotUSDScene.summarize(reset).areas[0].position),[2,0,2.5]);
});

async function withApp(run,workers="block"){
  const server=await serve(ROOT),browser=await launchBrowser();
  try{
    const browserContext=await browser.newContext({serviceWorkers:workers,viewport:{width:390,height:844}});
    const page=await browserContext.newPage();
    await page.goto(server.origin);
    await page.waitForFunction(()=>!!window.__avl);
    await run(page);
    await browserContext.close();
  }finally{await browser.close();await server.close();}
}

test("USD review is local, cancellable and adds only selected names without changing existing work",async()=>{
  await withApp(async page=>{
    await page.locator('[data-scope="visit"][data-k="client"]').fill("Keep this client");
    const before=await surveyStateSnapshot(page);
    const requests=[];
    page.on("request",request=>requests.push(request.url()));
    await page.locator("[data-usd-import]").scrollIntoViewIfNeeded();
    const scrollBefore=await page.evaluate(()=>scrollY);
    await page.locator("#usdin").setInputFiles(FIXTURE);
    await page.locator("[data-usd-add]").waitFor();
    assert.match(await page.locator("[data-usd-review]").textContent(),/3 objects · 1 named space/);
    assert.match(await page.locator("[data-usd-measurements]").textContent(),/13\.1 × 16\.4 ft/);
    assert.equal(await surveyStateSnapshot(page),before);
    assert.deepEqual(requests,[],"the parser must not fetch scene dependencies or upload the scan");
    assert.equal(await page.evaluate(()=>document.body.style.position),"fixed");
    const layout=await page.locator("[data-usd-close]").boundingBox();
    assert.ok(layout.height>=44 && layout.x>=0 && layout.x+layout.width<=390);
    await page.locator("[data-usd-close]").click();
    assert.equal(await surveyStateSnapshot(page),before);
    assert.ok(Math.abs(await page.evaluate(()=>scrollY)-scrollBefore)<2);
    assert.equal(await page.locator("[data-usd-import]").evaluate(el=>document.activeElement===el),true);
    await page.locator("#usdin").setInputFiles(FIXTURE);
    await page.locator("[data-usd-add]").click();
    const after=JSON.parse(await surveyStateSnapshot(page));
    const previous=JSON.parse(before);
    const added=after.rooms.pop();
    assert.deepEqual(added.d,{name:"Conference room"},"no per-room dimensions may be invented from whole-scene geometry");
    Object.keys(after.ui).filter(key=>key.startsWith(added.id+"|")).forEach(key=>delete after.ui[key]);
    Object.keys(after.skipped).filter(key=>key.startsWith(added.id+"|")).forEach(key=>delete after.skipped[key]);
    assert.deepEqual(after,previous,"only the new room and its default section UI may be added");
    await page.locator("#usdin").setInputFiles(FIXTURE);
    await page.locator("[data-usd-add]").waitFor();
    assert.equal(await page.locator("[data-usd-add]").isDisabled(),true,"re-import must not silently duplicate rooms");
    await page.keyboard.press("Escape");
    await until(()=>page.evaluate(()=>JSON.parse(localStorage.getItem("avl_survey_v1")).data.rooms.some(r=>r.d.name==="Conference room")));
    await page.reload();await page.waitForFunction(()=>!!window.__avl);
    assert.ok(await page.evaluate(()=>window.__avl.S().rooms.some(r=>r.d.name==="Conference room")));
  });
});

test("unknown-unit and invalid USD files cannot create misleading measurements or mutate the survey",async()=>{
  await withApp(async page=>{
    const before=await surveyStateSnapshot(page);
    await page.locator("#usdin").setInputFiles(join(ROOT,"tests/fixtures/usd-no-units.usd"));
    await page.locator("#usd-units").waitFor();
    assert.equal(await page.locator("#usd-units").inputValue(),"");
    assert.equal(await page.locator("[data-usd-measurements]").textContent(),"");
    await page.locator("#usd-units").selectOption("1");
    assert.match(await page.locator("[data-usd-measurements]").textContent(),/Whole-scan bounds/);
    assert.equal(await surveyStateSnapshot(page),before);
    await page.locator("[data-usd-close]").click();
    await page.locator("#usdin").setInputFiles({name:"broken.usd",mimeType:"application/octet-stream",buffer:Buffer.from("PXR-USDC")});
    await page.waitForFunction(()=>document.querySelector("[data-usd-review]").textContent.includes("Your survey has not changed"));
    assert.equal(await page.locator("[data-usd-add]").count(),0);
    assert.equal(await surveyStateSnapshot(page),before);
    await page.locator("[data-usd-close]").click();
  });
});

test("USD imports still work after the installed app reloads offline",async()=>{
  await withApp(async page=>{
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await until(()=>page.evaluate(()=>!!navigator.serviceWorker.controller));
    await page.context().setOffline(true);
    await page.reload();await page.waitForFunction(()=>!!window.__avl);
    await page.locator("#usdin").setInputFiles(FIXTURE);
    await page.locator("[data-usd-add]").waitFor();
    assert.match(await page.locator("[data-usd-review]").innerText(),/Conference room/);
    await page.locator("[data-usd-close]").click();
  },"allow");
});
