/* PrePlot's bounded static USD reader. No composition, animation or asset fetches.
 * Format references: OpenUSD pxr/usd/sdf/{crateFile,integerCoding}.cpp and
 * AOUSD Core Specification 1.0, binary crate format. This is an independent
 * implementation of that format, limited to static mesh/transform data.
 */
(function(root){
  "use strict";
  var MAX_FILE = 32 * 1024 * 1024;
  var MAX_ITEMS = 200000;
  var MAX_VALUES = 2000000;
  var MAX_TEXT = 4 * 1024 * 1024;
  var COMPOSITION = /^(subLayers|subLayerOffsets|references|payload|payloads|inheritPaths|specializes|variantSelection|variantSetNames|variantChildren|variantSetChildren|relocates|timeSamples|clips|instanceable)$/;
  var ATTRIBUTE = /^(points|extent|faceVertexCounts|faceVertexIndices|xformOpOrder|xformOp:.*|visibility|orientation|subdivisionScheme|size|radius|height|axis)$/;
  function fail(message){ throw new Error("USD: " + message); }
  function count(value,limit){
    if(typeof value !== "number" || !isFinite(value) || value < 0 || Math.floor(value) !== value || value > (limit || MAX_ITEMS)) fail("File exceeds the supported data limits.");
    return value;
  }
  function Reader(bytes,start,end){
    this.bytes = bytes; this.view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    this.pos = start || 0; this.end = end === undefined ? bytes.length : end;
  }
  Reader.prototype.need = function(n){ if(n < 0 || this.pos + n > this.end) fail("Truncated or invalid file."); };
  Reader.prototype.u8 = function(){ this.need(1); return this.bytes[this.pos++]; };
  Reader.prototype.u32 = function(){ this.need(4); var n=this.view.getUint32(this.pos,true); this.pos+=4; return n; };
  Reader.prototype.i32 = function(){ this.need(4); var n=this.view.getInt32(this.pos,true); this.pos+=4; return n; };
  Reader.prototype.u64 = function(){ var low=this.u32(),high=this.u32(); if(high>0x1fffff) fail("Integer exceeds the supported range."); return low+high*4294967296; };
  Reader.prototype.f32 = function(){ this.need(4); var n=this.view.getFloat32(this.pos,true); this.pos+=4; if(!isFinite(n)) fail("Non-finite geometry value."); return n; };
  Reader.prototype.f64 = function(){ this.need(8); var n=this.view.getFloat64(this.pos,true); this.pos+=8; if(!isFinite(n)) fail("Non-finite geometry value."); return n; };
  Reader.prototype.take = function(n){ this.need(n); var b=this.bytes.subarray(this.pos,this.pos+n); this.pos+=n; return b; };
  Reader.prototype.finished = function(){ if(this.pos!==this.end) fail("Invalid structural section length."); };
  function utf8(bytes){
    try { return new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
    catch(error){ fail("Invalid UTF-8 text."); }
  }
  function literal(bytes){
    var text=""; for(var i=0;i<bytes.length && bytes[i];i++) text+=String.fromCharCode(bytes[i]); return text;
  }
  function table(array,index,label){ if(index < 0 || index >= array.length || array[index] === undefined) fail("Invalid " + label + " index."); return array[index]; }
  function lz4(bytes,limit,exact){
    count(limit,MAX_FILE); if(!bytes.length || bytes[0]!==0) fail("Unsupported compressed block framing.");
    var out=new Uint8Array(limit),p=1,q=0,token,length,extra,offset,i;
    while(p<bytes.length){
      token=bytes[p++]; length=token>>>4;
      if(length===15){ do { if(p>=bytes.length) fail("Truncated compressed literal."); extra=bytes[p++]; length+=extra; } while(extra===255); }
      if(p+length>bytes.length || q+length>limit) fail("Compressed data exceeds its declared bounds.");
      out.set(bytes.subarray(p,p+length),q); p+=length; q+=length;
      if(p===bytes.length) break;
      if(p+2>bytes.length) fail("Truncated compressed match.");
      offset=bytes[p]|(bytes[p+1]<<8); p+=2;
      if(!offset || offset>q) fail("Invalid compressed match offset.");
      length=(token&15)+4;
      if(length===19){ do { if(p>=bytes.length) fail("Truncated compressed match length."); extra=bytes[p++]; length+=extra; } while(extra===255); }
      if(q+length>limit) fail("Compressed data exceeds its declared bounds.");
      for(i=0;i<length;i++){ out[q]=out[q-offset]; q++; }
    }
    if(exact && q!==limit) fail("Compressed data has the wrong length.");
    return out.subarray(0,q);
  }
  function compressed(reader,limit,exact){ var n=count(reader.u64(),MAX_FILE); return lz4(reader.take(n),limit,exact); }
  function integers(reader,n){
    count(n); var data=compressed(reader,4+Math.ceil(n/4)+n*4,false),r=new Reader(data),common=r.i32();
    var codes=r.take(Math.ceil(n/4)),out=[],previous=0,code,delta,i;
    for(i=0;i<n;i++){
      code=(codes[i>>2]>>((i%4)*2))&3;
      if(code===0) delta=common;
      else if(code===1){ delta=r.u8(); if(delta>127) delta-=256; }
      else if(code===2){ r.need(2); delta=r.view.getInt16(r.pos,true); r.pos+=2; }
      else delta=r.i32();
      previous=(previous+delta)|0; out.push(previous);
    }
    r.finished(); return out;
  }
  function rep(reader){ return {low:reader.u32(),high:reader.u32()}; }
  function Crate(bytes){ this.bytes=bytes; this.sections=Object.create(null); this.values=0; this.fieldVisits=0; this.valueCache=Object.create(null); }
  Crate.prototype.section = function(name){ var s=this.sections[name]; if(!s) fail("Missing " + name + " section."); return new Reader(this.bytes,s.start,s.start+s.size); };
  Crate.prototype.read = function(){
    var r=new Reader(this.bytes),i,n,s,start,size,end,toc,tokens,tokenStart,data;
    if(literal(r.take(8))!=="PXR-USDC") fail("Not a USD crate file.");
    var major=r.u8(),minor=r.u8(),patch=r.u8();
    if(major!==0 || minor!==8 || patch!==0) fail("This importer currently supports static USDC version 0.8.0 files.");
    r.take(5); toc=r.u64(); if(toc<88 || toc>=this.bytes.length) fail("Invalid table of contents.");
    r.pos=toc; n=count(r.u64(),32);
    var ranges=[];
    for(i=0;i<n;i++){
      s=literal(r.take(16)); start=r.u64(); size=r.u64(); end=start+size;
      if(!/^[A-Z]+$/.test(s) || this.sections[s] || start<88 || size<8 || end>toc) fail("Invalid structural section.");
      this.sections[s]={start:start,size:size}; ranges.push({start:start,end:end});
    }
    r.finished(); ranges.sort(function(a,b){return a.start-b.start;});
    for(i=1;i<ranges.length;i++) if(ranges[i].start<ranges[i-1].end) fail("Overlapping structural sections.");
    this.dataEnd=ranges[0].start;
    r=this.section("TOKENS"); n=count(r.u64()); size=count(r.u64(),MAX_TEXT); data=compressed(r,size,true); r.finished();
    tokens=[]; tokenStart=0;
    for(i=0;i<data.length;i++) if(data[i]===0){tokens.push(utf8(data.subarray(tokenStart,i)));tokenStart=i+1;}
    if(tokens.length!==n || tokenStart!==data.length) fail("Invalid token table."); this.tokens=tokens;
    r=this.section("STRINGS"); n=count(r.u64()); this.strings=[];
    for(i=0;i<n;i++) this.strings.push(table(tokens,r.u32(),"string token")); r.finished();
    r=this.section("FIELDS"); n=count(r.u64()); var fieldNames=integers(r,n),fieldReps=new Reader(compressed(r,n*8,true)); r.finished();
    this.fields=[];
    for(i=0;i<n;i++){
      var fieldName=table(tokens,fieldNames[i],"field token");
      if(COMPOSITION.test(fieldName)) fail("Composed or animated USD scenes are not supported ("+fieldName+").");
      this.fields.push({name:fieldName,rep:rep(fieldReps)});
    }
    r=this.section("FIELDSETS"); n=count(r.u64()); this.fieldsets=integers(r,n); r.finished();
    r=this.section("PATHS"); n=count(r.u64()); if(r.u64()!==n) fail("Invalid path counts.");
    var pathIds=integers(r,n),elements=integers(r,n),jumps=integers(r,n); r.finished();
    this.paths=new Array(n); var visited=new Uint8Array(n),tasks=[{index:0,parent:"",depth:0}],task,p,parent,path,jump,element,pathChars=0,depth;
    while(tasks.length){
      task=tasks.pop(); p=task.index; parent=task.parent; depth=task.depth;
      while(p<n){
        if(visited[p]) fail("Invalid repeated path traversal."); visited[p]=1;
        if(depth>256) fail("USD hierarchy is too deep.");
        element=table(tokens,Math.abs(elements[p]),"path token");
        if(parent!=="" && (!element || /[\/.\[\]{}]/.test(element))) fail("Unsupported USD path element.");
        path=parent==="" ? "/" : (elements[p]<0 ? parent+"."+element : (parent==="/" ? "/" : parent+"/")+element);
        pathChars+=path.length;
        if(path.length>8192 || pathChars>MAX_TEXT) fail("USD paths exceed the supported data limits.");
        if(path.indexOf("{")!==-1 || path.indexOf("[")!==-1) fail("Variants and target paths are not supported.");
        if(pathIds[p]<0 || pathIds[p]>=n || this.paths[pathIds[p]]!==undefined) fail("Invalid path index.");
        this.paths[pathIds[p]]=path; jump=jumps[p];
        if(jump < -2 || (jump>0 && p+jump>=n)) fail("Invalid path jump.");
        if(jump>0) tasks.push({index:p+jump,parent:parent,depth:depth});
        if(jump===-2) break;
        if(jump===-1 || jump>0){ parent=path; depth++; }
        p++;
      }
    }
    for(i=0;i<n;i++) if(!visited[i] || this.paths[i]===undefined) fail("Incomplete path table.");
    r=this.section("SPECS"); n=count(r.u64()); var specPaths=integers(r,n),specFields=integers(r,n),specTypes=integers(r,n); r.finished();
    var specs=[];
    for(i=0;i<n;i++) specs.push({path:table(this.paths,specPaths[i],"spec path"),type:specTypes[i],fields:this.fieldMap(specFields[i])});
    return this.scene(specs);
  };
  Crate.prototype.fieldMap = function(index){
    var fields=Object.create(null),steps=0,f;
    while(true){
      if(index<0 || index>=this.fieldsets.length || ++steps>10000) fail("Invalid field set.");
      if(++this.fieldVisits>MAX_VALUES) fail("Too many expanded USD fields.");
      var id=this.fieldsets[index++]; if(id===-1) break;
      f=table(this.fields,id,"field"); if(Object.prototype.hasOwnProperty.call(fields,f.name)) fail("Duplicate field.");
      if(COMPOSITION.test(f.name)) fail("Composed or animated USD scenes are not supported ("+f.name+").");
      fields[f.name]=f.rep;
    }
    return fields;
  };
  Crate.prototype.value = function(value){
    if(!value) return undefined;
    var key=value.low+":"+value.high;
    if(!Object.prototype.hasOwnProperty.call(this.valueCache,key)) this.valueCache[key]=this.decodeValue(value);
    return this.valueCache[key];
  };
  Crate.prototype.decodeValue = function(value){
    var type=(value.high>>>16)&255,inline=!!(value.high&0x40000000),array=!!(value.high&0x80000000),packed=!!(value.high&0x20000000);
    var payload=value.low+(value.high&65535)*4294967296,r,number,i,n,result=[],self=this;
    var widths={13:4,14:9,15:16,16:4,17:4,19:2,20:2,22:2,23:3,24:3,26:3,27:4,28:4,30:4};
    function account(amount){self.values+=amount;if(self.values>MAX_VALUES)fail("Too much scene data.");}
    if(array && payload===0) return [];
    function scalar(){
      if(type===1) return !!r.u8();
      if(type===2) return r.u8();
      if(type===3 || type===42 || type===44) return r.i32();
      if(type===4) return r.u32();
      if(type===8) return r.f32();
      if(type===9) return r.f64();
      if(type===10) return table(self.strings,r.u32(),"string");
      if(type===11) return table(self.tokens,r.u32(),"token");
      var length=widths[type],a=[],j;
      if(!length) fail("Unsupported value type " + type + ".");
      var doubles=type===13||type===14||type===15||type===16||type===19||type===23||type===27;
      var ints=type===22||type===26||type===30;
      for(j=0;j<length;j++) a.push(doubles?r.f64():(ints?r.i32():r.f32()));
      if(type>=13&&type<=15){ var rows=[],width=type-11; for(j=0;j<width;j++) rows.push(a.slice(j*width,(j+1)*width)); return rows; }
      return a;
    }
    if(inline){
      if(array || packed) fail("Unsupported inline array.");
      account(widths[type]||1);
      r=new Reader(new Uint8Array(4)); r.view.setUint32(0,value.low,true);
      if(type===9) return r.f32();
      if(type===11) return table(this.tokens,value.low,"token");
      if(type===10) return table(this.strings,value.low,"string");
      if(type>=13&&type<=15){
        n=type-11;
        for(i=0;i<n;i++){ var row=[]; number=(value.low>>>(i*8))&255; if(number>127) number-=256; for(var j=0;j<n;j++) row.push(i===j?number:0); result.push(row); }
        return result;
      }
      var inlineDims={19:2,20:2,22:2,23:3,24:3,26:3,27:4,28:4,30:4};
      if(inlineDims[type]){for(i=0;i<inlineDims[type];i++){number=(value.low>>>(i*8))&255;result.push(number>127?number-256:number);}return result;}
      return scalar();
    }
    if(payload<88 || payload>=this.dataEnd) fail("Invalid value offset."); r=new Reader(this.bytes,payload,this.dataEnd);
    if(type===41){ n=count(r.u64()); account(n); for(i=0;i<n;i++) result.push(table(this.tokens,r.u32(),"token")); return result; }
    if(array){
      n=count(r.u64()); account(n*(widths[type]||1));
      if(packed){ if(type!==3 && type!==4) fail("Unsupported compressed geometry array."); return integers(r,n); }
      for(i=0;i<n;i++) result.push(scalar()); return result;
    }
    if(packed) fail("Unsupported compressed scalar."); account(widths[type]||1); return scalar();
  };
  Crate.prototype.scene = function(specs){
    var self=this,prims=[],byPath=Object.create(null),metadata=Object.create(null),attributes=[];
    specs.forEach(function(spec){
      if(spec.type===7){
        if(spec.path!=="/") fail("Invalid scene root.");
        ["upAxis","metersPerUnit","defaultPrim"].forEach(function(name){if(spec.fields[name]) metadata[name]=self.value(spec.fields[name]);});
      }else if(spec.type===6){
        if(spec.path.indexOf(".")!==-1 || byPath[spec.path]) fail("Invalid or duplicate prim path.");
        var prim={path:spec.path,type:self.value(spec.fields.typeName)||"",metadata:Object.create(null),attributes:Object.create(null)};
        ["specifier","displayName","active","hidden","kind"].forEach(function(name){if(spec.fields[name])prim.metadata[name]=self.value(spec.fields[name]);});
        if(prim.metadata.specifier!==0) fail("Only defined, static prims are supported.");
        byPath[spec.path]=prim; prims.push(prim);
      }else if(spec.type===1) attributes.push(spec);
      else if(spec.type!==8) fail("Unsupported USD spec type " + spec.type + ".");
    });
    attributes.forEach(function(spec){
      var dot=spec.path.lastIndexOf("."),path=spec.path.slice(0,dot),name=spec.path.slice(dot+1),prim=byPath[path];
      if(!ATTRIBUTE.test(name)) return;
      if(!prim) fail("Attribute has no containing prim.");
      if(!spec.fields.default) fail("Static attribute has no default ("+name+").");
      prim.attributes[name]=self.value(spec.fields.default);
    });
    return validate({format:"usdc",version:"0.8.0",upAxis:metadata.upAxis||"Y",metersPerUnit:metadata.metersPerUnit===undefined?null:metadata.metersPerUnit,metadata:metadata,prims:prims});
  };
  function validate(scene){
    if(scene.upAxis!=="Y" && scene.upAxis!=="Z") fail("Unsupported up axis.");
    if(scene.metersPerUnit!==null && (typeof scene.metersPerUnit!=="number" || !isFinite(scene.metersPerUnit) || scene.metersPerUnit<=0)) fail("Invalid scene units.");
    var geometries=0;
    scene.prims.forEach(function(prim){
      var a=prim.attributes;
      if(/^(Cube|Sphere|Capsule|Cone|Cylinder|Plane|BasisCurves|NurbsCurves|NurbsPatch|Points|PointInstancer|TetMesh)$/.test(prim.type)) fail("Unsupported geometry type " + prim.type + "; export polygon meshes.");
      if(a["xformOp:transform"]){ var m=a["xformOp:transform"]; if(!Array.isArray(m)||m.length!==4||m.some(function(row){return !Array.isArray(row)||row.length!==4;})) fail("Invalid transform matrix."); }
      if(prim.type!=="Mesh") return;
      geometries++;
      if(a.subdivisionScheme!=="none") fail("Subdivided meshes are not supported; export polygon meshes with subdivisionScheme none.");
      if(!Array.isArray(a.points) || !a.points.length || a.points.some(function(p){return !Array.isArray(p)||p.length!==3;})) fail("Mesh has invalid or missing points.");
      if(!Array.isArray(a.faceVertexCounts)||!Array.isArray(a.faceVertexIndices)) fail("Mesh has no polygon topology.");
      var total=0;
      a.faceVertexCounts.forEach(function(n){if(n<3||Math.floor(n)!==n)fail("Invalid polygon size.");total+=n;});
      if(total!==a.faceVertexIndices.length) fail("Polygon counts do not match the index array.");
      a.faceVertexIndices.forEach(function(n){if(n<0||n>=a.points.length||Math.floor(n)!==n)fail("Invalid mesh point index.");});
    });
    if(!geometries) fail("No static mesh geometry was found.");
    return scene;
  }
  function parse(input){
    var bytes;
    if(input instanceof ArrayBuffer) bytes=new Uint8Array(input);
    else if(input && input.buffer instanceof ArrayBuffer) bytes=new Uint8Array(input.buffer,input.byteOffset||0,input.byteLength);
    else fail("Choose a binary .usd or .usdc file.");
    if(bytes.length<88 || bytes.length>MAX_FILE) fail("Choose a USD file smaller than 32 MB.");
    if(literal(bytes.subarray(0,8))!=="PXR-USDC") fail("This importer currently supports binary .usd and .usdc files, not text USD or USDZ archives.");
    return new Crate(bytes).read();
  }
  var api={parse:parse,maxFileBytes:MAX_FILE};
  if(typeof module!=="undefined" && module.exports) module.exports=api;
  root.PrePlotUSD=api;
})(typeof window!=="undefined"?window:this);
