(function(root){
  "use strict";

  var MAX_LENGTH = 240;

  function isPlainObject(value){
    if(!value || typeof value !== "object" || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function photoId(entry){
    if(typeof entry === "string") return entry;
    if(entry && typeof entry === "object" && typeof entry.id === "string"){
      return entry.id;
    }
    return "";
  }

  function isCaptionable(entry){
    return !!entry && typeof entry === "object" && !Array.isArray(entry) &&
      typeof entry.id === "string" && entry.id.length > 0 &&
      typeof entry.mime === "string" && entry.mime.length > 0 &&
      typeof entry.bytes === "number" &&
      typeof entry.width === "number" &&
      typeof entry.height === "number";
  }

  function normalise(value){
    return String(value === undefined || value === null ? "" : value)
      .replace(/^\s+|\s+$/g,"")
      .slice(0,MAX_LENGTH);
  }

  function get(state,entry){
    var id = photoId(entry);
    if(!id || !state || !isPlainObject(state.captions)) return "";
    return typeof state.captions[id] === "string" ? state.captions[id] : "";
  }

  function set(state,entry,value){
    var id = photoId(entry);
    if(!id || !isCaptionable(entry)) return false;
    if(!isPlainObject(state.captions)) state.captions = {};
    var text = normalise(value);
    if(!text){
      delete state.captions[id];
      return true;
    }
    state.captions[id] = text;
    return true;
  }

  function remove(state,entry){
    var id = photoId(entry);
    if(!id || !state || !isPlainObject(state.captions)) return false;
    if(!Object.prototype.hasOwnProperty.call(state.captions,id)) return false;
    delete state.captions[id];
    return true;
  }

  function validate(map){
    if(!isPlainObject(map)) return "captions is malformed";
    var keys = Object.keys(map);
    for(var i=0;i<keys.length;i++){
      var id = keys[i];
      if(typeof map[id] !== "string") return "caption " + id + " is not text";
      if(!normalise(map[id])) return "caption " + id + " is blank";
      if(map[id].length > MAX_LENGTH) return "caption " + id + " is too long";
    }
    return "";
  }

  function repair(map,validIds){
    var cleaned = {};
    if(!isPlainObject(map)) return cleaned;
    Object.keys(map).forEach(function(id){
      if(validIds[id]) cleaned[id] = map[id];
    });
    return cleaned;
  }

  root.PrePlotCaptions = {
    MAX_LENGTH:MAX_LENGTH,
    isPlainObject:isPlainObject,
    photoId:photoId,
    isCaptionable:isCaptionable,
    normalise:normalise,
    get:get,
    set:set,
    remove:remove,
    validate:validate,
    repair:repair
  };
})(window);
