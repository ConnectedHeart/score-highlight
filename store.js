/* 곡 저장소(IndexedDB). 곡 = MIDI 1개 + 음원 여러 개. 폰 안에만 저장한다. */
(function (root) {
  'use strict';
  var DB_NAME = 'scoreHighlight', STORE = 'songs';
  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var st = t.objectStore(STORE);
        var result;
        var r = fn(st);
        if (r) r.onsuccess = function () { result = r.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('저장 실패(용량 부족일 수 있음)')); };
      });
    });
  }

  root.SongStore = {
    list: function () {
      return tx('readonly', function (st) { return st.getAll(); }).then(function (all) {
        return (all || []).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      });
    },
    get: function (id) { return tx('readonly', function (st) { return st.get(id); }); },
    put: function (song) { song.updatedAt = Date.now(); return tx('readwrite', function (st) { return st.put(song); }); },
    remove: function (id) { return tx('readwrite', function (st) { return st.delete(id); }); }
  };
})(typeof self !== 'undefined' ? self : this);
