/*
 * 곡 묶음(.zip, 압축 없음): song.json + MIDI + 음원.
 * 일반 압축 프로그램으로도 풀 수 있고, 앱은 "새 곡 추가"에서 이 zip을 고르면 곡을 그대로 가져온다.
 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) {
    var c = 0xffffffff;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(s); }

  // files: [{ name, data: Uint8Array }] → Blob
  function writeZip(files) {
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data, crc = crc32(data);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); // UTF-8 이름
      h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true);
      c.setUint16(34, 0, true); c.setUint16(36, 0, true); c.setUint32(38, 0, true); c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function (s, b) { return s + (b.byteLength !== undefined ? b.byteLength : b.length); }, 0);
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' });
  }

  // 압축 없는 zip 읽기(이 앱이 만든 것). 압축된 항목이 있으면 오류.
  function readZip(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(buf);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip 파일이 아닙니다');
    var n = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true), out = {};
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip 목록이 깨졌습니다');
      var method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
      var nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      var local = dv.getUint32(p + 42, true);
      var name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nlen));
      if (method !== 0) throw new Error('압축된 zip은 읽지 못합니다(이 앱에서 내보낸 곡 묶음만 가능)');
      var lnlen = dv.getUint16(local + 26, true), lelen = dv.getUint16(local + 28, true);
      var start = local + 30 + lnlen + lelen;
      out[name] = u8.slice(start, start + size);
      p += 46 + nlen + elen + clen;
    }
    return out;
  }

  function toBase64(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  root.SongPack = { writeZip: writeZip, readZip: readZip, toBase64: toBase64, crc32: crc32 };
})(typeof self !== 'undefined' ? self : this);
