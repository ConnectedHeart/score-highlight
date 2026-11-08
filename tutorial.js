/*
 * 튜토리얼: 화면의 버튼을 하나씩 짚어 설명하는 안내(코치 마크) + 예제 곡 MIDI 만들기.
 * 예제 곡은 '반짝반짝 작은 별'(Twinkle Twinkle Little Star, 1806년 가사·전래 선율, 저작권 없음)을
 * 앱이 직접 4성부(Soprano, Alto, Tenor, Bass)로 화성을 붙여 만든다.
 */
(function (root) {
  'use strict';

  // ---------------- 예제 곡 MIDI 만들기 ----------------
  function vlq(n) {
    var bytes = [n & 0x7f];
    while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
    return bytes;
  }
  function textBytes(s) { return Array.from(new TextEncoder().encode(s)); }
  function meta(type, data) { return [0xff, type].concat(vlq(data.length), data); }
  function chunk(id, data) {
    var len = data.length;
    return Array.from(new TextEncoder().encode(id)).concat([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], data);
  }

  function makeSampleMidi() {
    var PPQ = 480, BPM = 100;
    // [음높이, 박 수, 가사] — 가사 끝 공백 = 단어 끝, 공백 없음 = 다음 음절로 이어짐
    var L1 = [[60, 1, 'Twin'], [60, 1, 'kle '], [67, 1, 'twin'], [67, 1, 'kle '], [69, 1, 'lit'], [69, 1, 'tle '], [67, 2, 'star ']];
    var L2 = [[65, 1, 'How '], [65, 1, 'I '], [64, 1, 'won'], [64, 1, 'der '], [62, 1, 'what '], [62, 1, 'you '], [60, 2, 'are ']];
    var L3 = [[67, 1, 'Up '], [67, 1, 'a'], [65, 1, 'bove '], [65, 1, 'the '], [64, 1, 'world '], [64, 1, 'so '], [62, 2, 'high ']];
    var L4 = [[67, 1, 'Like '], [67, 1, 'a '], [65, 1, 'dia'], [65, 1, 'mond '], [64, 1, 'in '], [64, 1, 'the '], [62, 2, 'sky ']];
    var melody = [].concat(L1, L2, L3, L4, L1, L2);
    // 2박마다 화음
    var CH = { C: { tones: [0, 4, 7], root: 48 }, F: { tones: [5, 9, 0], root: 41 }, G: { tones: [7, 11, 2], root: 43 }, G7: { tones: [7, 11, 2, 5], root: 43 } };
    var chordsByHalf = [].concat(
      ['C', 'C', 'F', 'C'], ['F', 'C', 'G', 'C'], ['C', 'G7', 'C', 'G'], ['C', 'G7', 'C', 'G'],
      ['C', 'C', 'F', 'C'], ['F', 'C', 'G', 'C']);

    function pick(tones, lo, hi) {
      for (var p = hi; p >= lo; p--) if (tones.indexOf(((p % 12) + 12) % 12) >= 0) return p;
      return null;
    }
    var parts = { S: [], A: [], T: [], B: [] };
    var beat = 0;
    melody.forEach(function (n) {
      var ch = CH[chordsByHalf[Math.floor(beat / 2)]];
      var s = n[0];
      var a = pick(ch.tones, s - 9, s - 1); if (a === null) a = s - 5;
      var t = pick(ch.tones, Math.max(45, a - 9), Math.min(57, a - 1)); if (t === null) t = a - 5;
      var b = ch.root;
      parts.S.push([s, n[1], n[2]]); parts.A.push([a, n[1], n[2]]); parts.T.push([t, n[1], n[2]]); parts.B.push([b, n[1], n[2]]);
      beat += n[1];
    });

    var tracks = [];
    var t0 = [].concat(
      [0], meta(0x03, textBytes('Twinkle Twinkle Little Star (예제)')),
      [0], meta(0x51, [(6e7 / BPM) >> 16 & 255, (6e7 / BPM) >> 8 & 255, (6e7 / BPM) & 255]),
      [0], meta(0x58, [4, 2, 24, 8]),
      [0], meta(0x59, [0, 0]),
      [0], meta(0x2f, []));
    tracks.push(t0);
    [['Soprano', 'S', 0], ['Alto', 'A', 1], ['Tenor', 'T', 2], ['Bass', 'B', 3]].forEach(function (def) {
      var ch = def[2];
      var ev = [0].concat(meta(0x03, textBytes(def[0])));
      var pending = 0; // 음 끄기 뒤 다음 음까지 남은 tick
      parts[def[1]].forEach(function (n) {
        var dur = n[1] * PPQ, on = Math.round(dur * 0.92);
        ev = ev.concat(vlq(pending), meta(0x05, textBytes(n[2])));
        ev = ev.concat([0, 0x90 | ch, n[0], 80]);
        ev = ev.concat(vlq(on), [0x80 | ch, n[0], 0]);
        pending = dur - on;
      });
      ev = ev.concat(vlq(pending), meta(0x2f, []));
      tracks.push(ev);
    });
    var header = chunk('MThd', [0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255]);
    var bytes = header;
    tracks.forEach(function (t) { bytes = bytes.concat(chunk('MTrk', t)); });
    return new Uint8Array(bytes).buffer;
  }

  // ---------------- 코치 마크 ----------------
  var overlay, spot, bubble, steps, idx, onEnd;

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  function ensureDom() {
    if (overlay) return;
    overlay = el('div', 'tut-overlay hidden');
    spot = el('div', 'tut-spot');
    bubble = el('div', 'tut-bubble');
    overlay.appendChild(spot); overlay.appendChild(bubble);
    document.body.appendChild(overlay);
    window.addEventListener('resize', function () { if (!overlay.classList.contains('hidden')) place(); });
  }

  function targetOf(step) {
    if (!step.target) return null;
    var t = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
    if (!t) return null;
    var r = t.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return r;
  }

  function place() {
    var step = steps[idx];
    var r = targetOf(step);
    var vw = window.innerWidth, vh = window.innerHeight, pad = 6;
    if (r) {
      spot.style.display = 'block';
      spot.style.left = (r.left - pad) + 'px'; spot.style.top = (r.top - pad) + 'px';
      spot.style.width = (r.width + pad * 2) + 'px'; spot.style.height = (r.height + pad * 2) + 'px';
      overlay.classList.remove('dim');
    } else {
      spot.style.display = 'none';
      overlay.classList.add('dim');
    }
    bubble.style.left = '12px'; bubble.style.right = '12px';
    var bh = bubble.offsetHeight;
    var top;
    if (!r) top = Math.max(20, (vh - bh) / 2);
    else if (r.bottom + pad + 12 + bh < vh - 8) top = r.bottom + pad + 12;          // 아래
    else if (r.top - pad - 12 - bh > 8) top = r.top - pad - 12 - bh;                // 위
    else top = Math.max(8, vh - bh - 8);
    bubble.style.top = top + 'px';
  }

  function render() {
    var step = steps[idx];
    var last = idx === steps.length - 1;
    bubble.innerHTML = '';
    var head = el('div', 'tut-head');
    head.appendChild(el('span', 'tut-count', (idx + 1) + ' / ' + steps.length));
    var skip = el('button', 'tut-skip', '건너뛰기');
    skip.onclick = function () { end(true); };
    if (!last) head.appendChild(skip);
    bubble.appendChild(head);
    bubble.appendChild(el('div', 'tut-title', step.title));
    bubble.appendChild(el('div', 'tut-text', step.text));
    var nav = el('div', 'tut-nav');
    var prev = el('button', 'small', '이전');
    prev.disabled = idx === 0;
    prev.onclick = function () { go(idx - 1); };
    var next = el('button', 'small primary', last ? '시작하기' : (step.nextLabel || '다음'));
    next.onclick = function () { if (last) end(false); else go(idx + 1); };
    nav.appendChild(prev); nav.appendChild(next);
    bubble.appendChild(nav);
    place();
  }

  function go(i) {
    var step = steps[i];
    idx = i;
    var p = step.before ? Promise.resolve(step.before()) : Promise.resolve();
    overlay.classList.add('busy');
    p.then(function () {
      return new Promise(function (r) { setTimeout(r, step.wait || 60); });
    }).then(function () { overlay.classList.remove('busy'); render(); })
      .catch(function (e) { console.error(e); overlay.classList.remove('busy'); render(); });
  }

  function start(stepList, endCb) {
    ensureDom();
    steps = stepList; onEnd = endCb;
    overlay.classList.remove('hidden');
    go(0);
  }
  function end(skipped) {
    overlay.classList.add('hidden');
    if (onEnd) onEnd(skipped);
  }
  function isOpen() { return overlay && !overlay.classList.contains('hidden'); }

  root.Tutorial = { start: start, end: end, isOpen: isOpen, makeSampleMidi: makeSampleMidi };
})(typeof self !== 'undefined' ? self : this);
