import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = { TextDecoder, ArrayBuffer, DataView, Uint8Array };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("../usd-import.js", import.meta.url), "utf8"), context);
const parse = function(bytes){ return JSON.parse(JSON.stringify(context.PrePlotUSD.parse(bytes))); };
const fixture = fs.readFileSync(new URL("./fixtures/usd-room-scan.usd", import.meta.url));

function section(bytes, wanted){
  let pos = Number(bytes.readBigUInt64LE(16));
  const count = Number(bytes.readBigUInt64LE(pos));
  pos += 8;
  for(let i=0;i<count;i++,pos+=32){
    if(bytes.subarray(pos,pos+16).toString().replace(/\0.*$/s, "") === wanted){
      return { start:Number(bytes.readBigUInt64LE(pos+16)), size:Number(bytes.readBigUInt64LE(pos+24)) };
    }
  }
  throw new Error("Missing fixture section");
}

test("USD parser reads static mesh data, units and transforms from an independently written crate", function(){
  const scene = parse(fixture);
  assert.equal(scene.format, "usdc");
  assert.equal(scene.version, "0.8.0");
  assert.equal(scene.upAxis, "Y");
  assert.equal(scene.metersPerUnit, 1);
  const root = scene.prims.find(function(p){return p.path === "/SyntheticScan";});
  assert.deepEqual(root.attributes["xformOp:transform"], [[1,0,0,0],[0,1,0,0],[0,0,1,0],[10,0,20,1]]);
  assert.deepEqual(root.attributes.xformOpOrder, ["xformOp:transform"]);
  const meshes = scene.prims.filter(function(p){ return p.type === "Mesh"; });
  assert.deepEqual(meshes.map(function(p){return p.path.split("/").pop();}), ["Wall0","Wall1","Floor0"]);
  assert.deepEqual(meshes[0].attributes.points, [[0,0,0],[4,0,0],[4,3,0],[0,3,0]]);
  assert.deepEqual(meshes[0].attributes.faceVertexCounts, [4]);
  assert.deepEqual(meshes[0].attributes.faceVertexIndices, [0,1,2,3]);
  assert.deepEqual(meshes[1].attributes.faceVertexIndices, [0,1,2,0,2,3]);
  assert.deepEqual(meshes[0].attributes.extent, [[0,0,0],[4,3,0]]);
  const area = scene.prims.find(function(p){return /\/conferenceRoom0$/.test(p.path);});
  assert.equal(area.metadata.displayName, "Conference room");
  assert.deepEqual(area.attributes["xformOp:transform"][3], [2,0,2.5,1]);
});

test("USD parser rejects truncation and oversized structural claims before allocating", function(){
  [0,7,16,24,87,100,fixture.length-1,fixture.length-40].forEach(function(length){
    assert.throws(function(){parse(fixture.subarray(0,length));}, /USD:/);
  });
  const hugeTokens = Buffer.from(fixture);
  hugeTokens.writeBigUInt64LE(1000000000n, section(hugeTokens,"TOKENS").start+8);
  assert.throws(function(){parse(hugeTokens);}, /limits/);
  const hugeFields = Buffer.from(fixture);
  hugeFields.writeBigUInt64LE(1000000000n, section(hugeFields,"FIELDS").start);
  assert.throws(function(){parse(hugeFields);}, /limits/);
  const outside = Buffer.from(fixture);
  outside.writeBigUInt64LE(BigInt(fixture.length+1), 16);
  assert.throws(function(){parse(outside);}, /table of contents/);
});

test("USD parser rejects corrupt compressed blocks and non-finite geometry", function(){
  const invalidCompression = Buffer.from(fixture);
  invalidCompression[section(invalidCompression,"TOKENS").start+24] = 4;
  assert.throws(function(){parse(invalidCompression);}, /compressed block/);
  const points = Buffer.alloc(48);
  [0,0,0,4,0,0,4,3,0,0,3,0].forEach(function(n,i){points.writeFloatLE(n,i*4);});
  const offset = fixture.indexOf(points);
  assert.ok(offset >= 88, "independently written fixture includes uncompressed mesh points");
  const invalidPoint = Buffer.from(fixture);
  invalidPoint.writeFloatLE(NaN,offset);
  assert.throws(function(){parse(invalidPoint);}, /Non-finite geometry/);
  const oversizedPoints = Buffer.from(fixture);
  oversizedPoints.writeBigUInt64LE(1000000000n,offset-8);
  assert.throws(function(){parse(oversizedPoints);}, /limits/);
});

test("USD parser declares its supported format instead of misreading other USD encodings", function(){
  const newer = Buffer.from(fixture);
  newer[9] = 12;
  assert.throws(function(){parse(newer);}, /0\.8\.0/);
  const text = fs.readFileSync(new URL("./fixtures/usd-room-scan.usda",import.meta.url));
  assert.throws(function(){parse(text);}, /not text USD or USDZ/);
  const zip = Buffer.from(fixture);
  zip.write("PK\x03\x04",0,"binary");
  assert.throws(function(){parse(zip);}, /not text USD or USDZ/);
});

test("USD parser preserves absent units and rejects composition or partially supported geometry", function(){
  const unknownUnits = fs.readFileSync(new URL("./fixtures/usd-no-units.usd",import.meta.url));
  assert.equal(parse(unknownUnits).metersPerUnit,null,"physical scale cannot be inferred from untagged scene coordinates");
  const composed = fs.readFileSync(new URL("./fixtures/usd-composed-scan.usd",import.meta.url));
  assert.throws(function(){parse(composed);}, /Composed or animated/);
  const geometry = fs.readFileSync(new URL("./fixtures/usd-unsupported-geometry.usd",import.meta.url));
  assert.throws(function(){parse(geometry);}, /Unsupported geometry type Cube/);
});

test("USD parser rejects explicit and implicit subdivision instead of measuring a control mesh", function(){
  ["usd-subdivided.usd","usd-default-subdivision.usd"].forEach(function(name){
    const bytes = fs.readFileSync(new URL("./fixtures/"+name,import.meta.url));
    assert.throws(function(){parse(bytes);}, /Subdivided meshes are not supported/);
  });
});
