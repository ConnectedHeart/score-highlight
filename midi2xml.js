/*
 * MIDI → MusicXML 변환 + 음표 시각표 만들기.
 * 브라우저(window.Midi2Xml)와 Node(require) 양쪽에서 쓴다.
 *
 * 결과:
 *   xml    : OpenSheetMusicDisplay가 그릴 MusicXML 문자열
 *   events : 그려진 음표 조각마다 { part, measure, pos(마디 안 위치, 4분음표=24), startTick, endTick }
 *   parts  : 파트 정보 { name, channel, avgPitch, noteCount, firstTick }
 *   tickToSec / secToTick : 템포 지도에 따른 시간 변환
 */
(function (root) {
  'use strict';

  var DIV = 24; // MusicXML divisions: 4분음표 하나 = 24

  // ---------------- MIDI 파서 ----------------
  function parseMidi(buffer) {
    var data = new Uint8Array(buffer);
    var p = 0;
    function u32() { var v = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; p += 4; return v >>> 0; }
    function u16() { var v = (data[p] << 8) | data[p + 1]; p += 2; return v; }
    function vlq() { var v = 0, b; do { b = data[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; }
    function str(n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(data[p + i]); return s; }

    if (str(4) !== 'MThd') throw new Error('MIDI 파일이 아닙니다');
    p += 4;
    var hlen = u32();
    var hstart = p;
    var format = u16(), ntracks = u16(), division = u16();
    p = hstart + hlen;
    if (division & 0x8000) throw new Error('SMPTE 시간 단위 MIDI는 지원하지 않습니다');

    var tracks = [];
    for (var t = 0; t < ntracks && p < data.length; t++) {
      var id = str(4); p += 4;
      var len = u32();
      var end = p + len;
      if (id !== 'MTrk') { p = end; t--; continue; }
      var events = [], tick = 0, running = 0;
      while (p < end) {
        tick += vlq();
        var status = data[p];
        if (status < 0x80) status = running; else p++;
        if (status === 0xff) {
          var type = data[p++], mlen = vlq();
          var bytes = data.subarray(p, p + mlen);
          p += mlen;
          var ev = { tick: tick, meta: type };
          if (type === 0x51) ev.uspq = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
          else if (type === 0x58) { ev.num = bytes[0]; ev.den = Math.pow(2, bytes[1]); }
          else if (type === 0x59) { ev.sf = bytes[0] > 127 ? bytes[0] - 256 : bytes[0]; ev.mi = bytes[1]; }
          else if (type >= 0x01 && type <= 0x07) ev.bytes = bytes.slice();
          events.push(ev);
        } else if (status === 0xf0 || status === 0xf7) {
          var slen = vlq(); p += slen;
        } else {
          running = status;
          var cmd = status & 0xf0, ch = status & 0x0f;
          if (cmd === 0xc0 || cmd === 0xd0) { p += 1; }
          else {
            var d1 = data[p++], d2 = data[p++];
            if (cmd === 0x90 && d2 > 0) events.push({ tick: tick, on: true, ch: ch, key: d1, vel: d2 });
            else if (cmd === 0x80 || cmd === 0x90) events.push({ tick: tick, off: true, ch: ch, key: d1 });
          }
        }
      }
      p = end;
      tracks.push(events);
    }
    return { format: format, ppq: division, tracks: tracks };
  }

  function decodeText(bytes) {
    if (!bytes) return '';
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* 다음 시도 */ }
    try { return new TextDecoder('euc-kr').decode(bytes); } catch (e) { /* 다음 시도 */ }
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s;
  }

  // ---------------- 분석 ----------------
  function analyze(buffer, opts) {
    opts = opts || {};
    var midi = parseMidi(buffer);
    var ppq = midi.ppq;
    var tempos = [], sigs = [], key = null, title = '';
    var parts = [];

    midi.tracks.forEach(function (events, ti) {
      var name = '', lyrics = [], notes = [], open = {}, chans = {};
      events.forEach(function (e) {
        if (e.meta === 0x51) tempos.push({ tick: e.tick, uspq: e.uspq });
        else if (e.meta === 0x58) sigs.push({ tick: e.tick, num: e.num, den: e.den });
        else if (e.meta === 0x59 && key === null) key = { fifths: e.sf, minor: e.mi === 1 };
        else if (e.meta === 0x03 && !name) name = decodeText(e.bytes).trim();
        else if (e.meta === 0x05) lyrics.push({ tick: e.tick, text: decodeText(e.bytes) });
        else if (e.on) {
          var k = e.ch + ':' + e.key;
          (open[k] = open[k] || []).push(notes.length);
          notes.push({ start: e.tick, end: null, key: e.key, ch: e.ch });
          chans[e.ch] = (chans[e.ch] || 0) + 1;
        } else if (e.off) {
          var k2 = e.ch + ':' + e.key;
          if (open[k2] && open[k2].length) notes[open[k2].shift()].end = e.tick;
        }
      });
      if (ti === 0 && name && !notes.length) title = name;
      if (!notes.length) return;
      notes.forEach(function (n) { if (n.end === null) n.end = n.start + ppq; });
      var channel = +Object.keys(chans).sort(function (a, b) { return chans[b] - chans[a]; })[0];
      if (channel === 9 && !opts.includeDrums) return;
      notes.sort(function (a, b) { return a.start - b.start || a.key - b.key; });
      var sum = 0; notes.forEach(function (n) { sum += n.key; });
      parts.push({
        name: name || ('Part ' + (parts.length + 1)),
        channel: channel, notes: notes, lyrics: lyrics,
        avgPitch: sum / notes.length, noteCount: notes.length, firstTick: notes[0].start
      });
    });
    if (!parts.length) throw new Error('MIDI에 음표가 있는 파트가 없습니다');

    tempos.sort(function (a, b) { return a.tick - b.tick; });
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, uspq: 500000 });
    sigs.sort(function (a, b) { return a.tick - b.tick; });
    if (!sigs.length || sigs[0].tick > 0) sigs.unshift({ tick: 0, num: 4, den: 4 });
    // 같은 tick 중복 제거(뒤의 것 사용)
    sigs = sigs.filter(function (s, i) { return i === sigs.length - 1 || sigs[i + 1].tick !== s.tick; });
    if (!key) key = { fifths: 0, minor: false };

    // 템포 지도
    var tmap = [], acc = 0;
    tempos.forEach(function (t, i) {
      if (i > 0) acc += (t.tick - tempos[i - 1].tick) * tempos[i - 1].uspq / 1e6 / ppq;
      tmap.push({ tick: t.tick, sec: acc, uspq: t.uspq });
    });
    function tickToSec(tick) {
      var i = tmap.length - 1; while (i > 0 && tmap[i].tick > tick) i--;
      return tmap[i].sec + (tick - tmap[i].tick) * tmap[i].uspq / 1e6 / ppq;
    }
    function secToTick(sec) {
      var i = tmap.length - 1; while (i > 0 && tmap[i].sec > sec) i--;
      return tmap[i].tick + (sec - tmap[i].sec) * 1e6 * ppq / tmap[i].uspq;
    }

    var endTick = 0;
    parts.forEach(function (pt) { pt.notes.forEach(function (n) { if (n.end > endTick) endTick = n.end; }); });

    // ---- 마디 경계 ----
    var unit = ppq / DIV;
    function measLen(s) { return Math.round(s.num * ppq * 4 / s.den); }
    var pickup = 0;
    if (typeof opts.pickupTicks === 'number') pickup = opts.pickupTicks;
    else if (sigs.length > 1) {
      pickup = (sigs[1].tick - sigs[0].tick) % measLen(sigs[0]);
      if (pickup % Math.round(ppq * 4 / sigs[0].den) !== 0) pickup = 0; // 박 단위가 아니면 못갖춘마디로 보지 않음
    }
    var measures = [], tick = 0, si = 0;
    function sigAt(tk) { var s = sigs[0]; for (var i = 0; i < sigs.length; i++) if (sigs[i].tick <= tk) s = sigs[i]; return s; }
    if (pickup > 0) { measures.push({ start: 0, end: pickup, sig: sigs[0], implicit: true }); tick = pickup; }
    while (tick < endTick || measures.length === 0) {
      var s = sigAt(tick);
      var len = measLen(s);
      // 다음 박자 변경이 마디 중간에 오면 그 지점에서 끊는다
      for (si = 0; si < sigs.length; si++) if (sigs[si].tick > tick && sigs[si].tick < tick + len) { len = sigs[si].tick - tick; break; }
      measures.push({ start: tick, end: tick + len, sig: s });
      tick += len;
    }

    // ---- 파트별 음표 정리(양자화) ----
    var STD = [3, 4, 6, 8, 9, 12, 16, 18, 24, 32, 36, 48, 72, 96, 144, 192];
    var lyricOv = opts.lyrics || {}; // { 파트번호: { 음표위치(q): '가사' } }, 끝이 '-'면 다음 음절로 이어짐, ''이면 가사 없음
    parts.forEach(function (pt, ptIndex) {
      var groups = []; // 같은 시작 = 화음
      pt.notes.forEach(function (n) {
        var qs = Math.round(n.start / unit);
        var g = groups.length ? groups[groups.length - 1] : null;
        if (g && g.qs === qs) { g.keys.push(n.key); g.rawEnd = Math.max(g.rawEnd, n.end); }
        else groups.push({ qs: qs, start: n.start, rawEnd: n.end, keys: [n.key] });
      });
      groups.forEach(function (g, i) {
        var next = i + 1 < groups.length ? groups[i + 1].qs : null;
        var raw = Math.max(1, Math.round((g.rawEnd - g.start) / unit));
        var qe;
        var tol = next !== null ? Math.max(3, Math.round(0.34 * (next - g.qs))) : 0;
        if (next !== null && g.qs + raw <= next && next - (g.qs + raw) <= tol) qe = next; // 레가토로 이어짐
        else {
          var d = STD[STD.length - 1];
          for (var k = 0; k < STD.length; k++) if (STD[k] >= raw) { d = STD[k]; break; }
          qe = g.qs + d;
        }
        if (next !== null && qe > next) qe = next;
        if (qe <= g.qs) qe = g.qs + 1;
        g.qe = qe;
        g.keys.sort(function (a, b) { return a - b; });
      });
      pt.groups = groups;

      // 가사: 음표 시작 tick에 붙인다
      var byTick = {};
      pt.lyrics.forEach(function (l) {
        var t = l.text.replace(/[\r\n]/g, '');
        if (!t.trim()) return;
        var q = Math.round(l.tick / unit);
        byTick[q] = (byTick[q] || '') + t;
      });
      var cont = false;
      var ov = lyricOv[ptIndex] || {};
      groups.forEach(function (g) {
        var text, endsWord;
        if (Object.prototype.hasOwnProperty.call(ov, g.qs)) {
          var s = String(ov[g.qs]).trim();
          endsWord = !/-$/.test(s);
          text = s.replace(/^-+|-+$/g, '').trim();
        } else {
          var t = byTick[g.qs];
          if (t === undefined) return;
          endsWord = /\s$/.test(t) || /[,.!?;:'"]$/.test(t);
          text = t.trim().replace(/^-+|-+$/g, '');
        }
        if (!text) return;
        var syl = cont ? (endsWord ? 'end' : 'middle') : (endsWord ? 'single' : 'begin');
        g.lyric = { text: text, syllabic: syl };
        cont = !endsWord;
      });

      // 음자리표
      // 높은 음역은 높은음자리표, 'Male' 같은 남성 멜로디는 옥타브 낮은 높은음자리표, 나머지는 낮은음자리표
      if (/soprano|alto|mezzo|소프라노|알토|메조/i.test(pt.name)) pt.clef = 'G'; // 여성 파트는 이름으로 높은음자리표
      else if (pt.avgPitch >= 62) pt.clef = 'G';
      else if (/male|남성/i.test(pt.name) && pt.avgPitch >= 55) pt.clef = 'G8';
      else pt.clef = 'F';
    });

    // ---------------- 음가 분해 ----------------
    var VALUES = [
      { v: 96, type: 'whole', dots: 0 }, { v: 72, type: 'half', dots: 1 }, { v: 48, type: 'half', dots: 0 },
      { v: 36, type: 'quarter', dots: 1 }, { v: 24, type: 'quarter', dots: 0 }, { v: 18, type: 'eighth', dots: 1 },
      { v: 12, type: 'eighth', dots: 0 }, { v: 9, type: '16th', dots: 1 }, { v: 6, type: '16th', dots: 0 },
      { v: 3, type: '32nd', dots: 0 },
      { v: 32, type: 'half', dots: 0, tup: true }, { v: 16, type: 'quarter', dots: 0, tup: true },
      { v: 8, type: 'eighth', dots: 0, tup: true }, { v: 4, type: '16th', dots: 0, tup: true },
      { v: 2, type: '32nd', dots: 0, tup: true }, { v: 1, type: '64th', dots: 0, tup: true, bad: true }
    ];
    var memo = {};
    function decompose(d) {
      if (memo[d]) return memo[d];
      // 비용 최소 분해(이진 음가 우선)
      var best = new Array(d + 1), cost = new Array(d + 1);
      cost[0] = 0; best[0] = null;
      for (var x = 1; x <= d; x++) {
        cost[x] = Infinity;
        for (var i = 0; i < VALUES.length; i++) {
          var val = VALUES[i];
          if (val.v > x || cost[x - val.v] === Infinity) continue;
          var c = cost[x - val.v] + (val.bad ? 20 : val.tup ? 1.6 : 1);
          if (c < cost[x]) { cost[x] = c; best[x] = val; }
        }
      }
      var out = [], r = d;
      while (r > 0) { out.push(best[r]); r -= best[r].v; }
      out.sort(function (a, b) { return b.v - a.v; });
      memo[d] = out;
      return out;
    }

    // ---------------- MusicXML 만들기 ----------------
    var SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    var FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
    function pitchXml(k) {
      var nm = (key.fifths < 0 ? FLAT : SHARP)[k % 12];
      var oct = Math.floor(k / 12) - 1;
      var alter = nm.length > 1 ? (nm[1] === '#' ? 1 : -1) : 0;
      return '<pitch><step>' + nm[0] + '</step>' + (alter ? '<alter>' + alter + '</alter>' : '') + '<octave>' + oct + '</octave></pitch>';
    }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    var events = [];
    var bpm = Math.round(60e6 / tempos[0].uspq);
    var xml = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
      '<score-partwise version="3.1">'];
    if (title) xml.push('<work><work-title>' + esc(title) + '</work-title></work>');
    xml.push('<part-list>');
    parts.forEach(function (pt, i) { xml.push('<score-part id="P' + (i + 1) + '"><part-name>' + esc(pt.name) + '</part-name></score-part>'); });
    xml.push('</part-list>');

    parts.forEach(function (pt, pi) {
      xml.push('<part id="P' + (pi + 1) + '">');
      var gi = 0, prevSig = null;
      measures.forEach(function (m, mi) {
        var ms = Math.round(m.start / unit), me = Math.round(m.end / unit);
        var attr = '';
        if (mi === 0) {
          attr += '<divisions>' + DIV + '</divisions><key><fifths>' + key.fifths + '</fifths><mode>' + (key.minor ? 'minor' : 'major') + '</mode></key>';
        }
        if (!prevSig || prevSig.num !== m.sig.num || prevSig.den !== m.sig.den) attr += '<time><beats>' + m.sig.num + '</beats><beat-type>' + m.sig.den + '</beat-type></time>';
        if (mi === 0) {
          if (pt.clef === 'G') attr += '<clef><sign>G</sign><line>2</line></clef>';
          else if (pt.clef === 'G8') attr += '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>';
          else attr += '<clef><sign>F</sign><line>4</line></clef>';
        }
        prevSig = m.sig;
        xml.push('<measure number="' + (pickup > 0 ? mi : mi + 1) + '"' + (m.implicit ? ' implicit="yes"' : '') + '>');
        if (attr) xml.push('<attributes>' + attr + '</attributes>');
        if (mi === 0 && pi === 0) xml.push('<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>' + bpm + '</per-minute></metronome></direction-type><sound tempo="' + bpm + '"/></direction>');

        // 이 마디에 걸친 음표 조각
        var pieces = [];
        while (gi < pt.groups.length && pt.groups[gi].qe <= ms) gi++;
        for (var j = gi; j < pt.groups.length && pt.groups[j].qs < me; j++) {
          var g = pt.groups[j];
          var s = Math.max(g.qs, ms), e = Math.min(g.qe, me);
          if (e > s) pieces.push({ s: s, e: e, g: g, first: s === g.qs, last: e === g.qe });
        }
        var cur = ms, out = [];
        if (!pieces.length) {
          xml.push('<note><rest measure="yes"/><duration>' + (me - ms) + '</duration></note>');
          xml.push('</measure>');
          return;
        }
        pieces.forEach(function (pc) {
          if (pc.s > cur) out.push({ rest: true, s: cur, e: pc.s });
          out.push(pc);
          cur = pc.e;
        });
        if (cur < me) out.push({ rest: true, s: cur, e: me });

        var tupAcc = 0, tupOpen = false;
        function emit(item, val, idx, count, pos) {
          var isTup = !!val.tup;
          var notations = '';
          var tupXml = '';
          if (isTup) {
            if (!tupOpen) { tupOpen = true; tupAcc = 0; notations += '<tuplet type="start" bracket="yes"/>'; }
            tupAcc += val.v;
            if (tupAcc % 24 === 0 || (val.v >= 32 && tupAcc % 96 === 0)) { notations += '<tuplet type="stop"/>'; tupOpen = false; }
            tupXml = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
          } else if (tupOpen) {
            tupOpen = false; // 닫히지 않은 셋잇단은 그대로 둔다
          }
          var body = '<duration>' + val.v + '</duration>';
          var typ = '<type>' + val.type + '</type>' + (val.dots ? '<dot/>' : '') + tupXml;
          if (item.rest) {
            xml.push('<note><rest/>' + body + typ + (notations ? '<notations>' + notations + '</notations>' : '') + '</note>');
            return;
          }
          var tieStart = !(item.last && idx === count - 1);
          var tieStop = !(item.first && idx === 0);
          var tieXml = (tieStop ? '<tie type="stop"/>' : '') + (tieStart ? '<tie type="start"/>' : '');
          var tiedXml = (tieStop ? '<tied type="stop"/>' : '') + (tieStart ? '<tied type="start"/>' : '');
          var nots = notations + tiedXml;
          item.g.keys.forEach(function (k, ci) {
            var lyr = '';
            if (ci === 0 && item.first && idx === 0 && item.g.lyric) {
              lyr = '<lyric number="1"><syllabic>' + item.g.lyric.syllabic + '</syllabic><text>' + esc(item.g.lyric.text) + '</text></lyric>';
            }
            xml.push('<note>' + (ci > 0 ? '<chord/>' : '') + pitchXml(k) + body + tieXml + typ +
              (nots ? '<notations>' + nots + '</notations>' : '') + lyr + '</note>');
          });
          var startTick = (item.first && idx === 0) ? item.g.start : (m.start + (pos - ms) * unit);
          events.push({ part: pi, measure: mi, pos: pos - ms, startTick: startTick, endTick: m.start + (pos + val.v - ms) * unit, keys: item.g.keys, head: item.first && idx === 0, q: item.g.qs, lyric: item.g.lyric || null });
        }
        out.forEach(function (item) {
          var vals = decompose(item.e - item.s);
          var pos = item.s;
          vals.forEach(function (val, idx) { emit(item, val, idx, vals.length, pos); pos += val.v; });
        });
        xml.push('</measure>');
      });
      xml.push('</part>');
    });
    xml.push('</score-partwise>');

    events.sort(function (a, b) { return a.startTick - b.startTick; });
    var firstTick = Infinity;
    parts.forEach(function (pt) { if (pt.firstTick < firstTick) firstTick = pt.firstTick; });

    return {
      xml: xml.join('\n'),
      events: events,
      title: title,
      ppq: ppq,
      bpm: bpm,
      pickup: pickup,
      measures: measures,
      endTick: endTick,
      firstTick: firstTick,
      parts: parts.map(function (pt) {
        return { name: pt.name, channel: pt.channel, avgPitch: pt.avgPitch, noteCount: pt.noteCount, firstTick: pt.firstTick, clef: pt.clef,
          notes: pt.notes.map(function (n) { return { start: n.start, end: n.end, key: n.key }; }) };
      }),
      tickToSec: tickToSec,
      secToTick: secToTick
    };
  }

  var api = { analyze: analyze, parseMidi: parseMidi, DIV: DIV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Midi2Xml = api;
})(typeof self !== 'undefined' ? self : this);
