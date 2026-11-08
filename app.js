/* 악보 하이라이트 앱 본체 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var player = $('player');
  var wrap = $('scoreWrap');

  var state = {
    song: null,         // 저장된 곡
    analysis: null,     // Midi2Xml.analyze 결과
    osmd: null,
    loadedSongId: null, // osmd에 올린 곡
    track: null,        // 선택한 음원
    zoom: 0.45,
    view: 'all',        // all | mine
    layout: 'page',     // page(좌우 페이지) | scroll(위아래)
    lyrics: 'sel',      // sel | all | none
    editLyrics: false,  // 가사 편집 모드
    lyricVer: 0,        // 가사를 고칠 때마다 올려 악보를 다시 불러온다
    pageW: 0, pageH: 0, page: 0,
    eventEls: [],       // events[i] → SVG 요소 배열
    elToEvent: new Map(),
    active: new Set(),
    maxDurTick: 0,
    syncMode: false,
    userScrollUntil: 0,
    objectUrl: null
  };

  try { state.zoom = parseFloat(localStorage.getItem('zoom')) || state.zoom; } catch (e) { /* 저장 불가 */ }
  try { state.view = localStorage.getItem('view') || state.view; } catch (e) { /* 저장 불가 */ }
  try { state.layout = localStorage.getItem('layout') || state.layout; } catch (e) { /* 저장 불가 */ }
  try { state.lyrics = localStorage.getItem('lyrics') || state.lyrics; } catch (e) { /* 저장 불가 */ }

  // ---------------- 공통 ----------------
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, ms || 2500);
  }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }
  function isMidi(f) { return /\.(mid|midi|kar)$/i.test(f.name) || /midi/i.test(f.type); }
  function readBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---------------- 화면 전환 ----------------
  function showList() {
    pause();
    $('songView').classList.add('hidden');
    $('listView').classList.remove('hidden');
    renderSongList();
  }
  function showSong() {
    $('listView').classList.add('hidden');
    $('songView').classList.remove('hidden');
  }

  // ---------------- 곡 목록 ----------------
  function renderSongList() {
    SongStore.list().then(function (songs) {
      var ul = $('songList');
      ul.innerHTML = '';
      if (!songs.length) {
        ul.innerHTML = '<li class="empty" style="cursor:default;border:none;background:none">아직 곡이 없습니다</li>';
        return;
      }
      songs.forEach(function (s) {
        var li = document.createElement('li');
        var b = document.createElement('b'); b.textContent = s.title;
        var sp = document.createElement('span');
        sp.textContent = '음원 ' + s.tracks.length + '개 · ' + s.tracks.map(function (t) { return t.name; }).join(', ');
        li.appendChild(b); li.appendChild(sp);
        li.onclick = function () { openSong(s.id); };
        ul.appendChild(li);
      });
    }).catch(function (e) { toast('목록을 읽지 못했습니다: ' + e.message); });
  }

  // ---------------- 파트 자동 연결 ----------------
  var ALIASES = {
    soprano: ['soprano', 'sop', '소프라노'], alto: ['alto', '알토'], tenor: ['tenor', 'ten', '테너'],
    baritone: ['baritone', 'bari', '바리톤'], bass: ['bass', '베이스'], male: ['male', '남성', '멜로디'],
    mezzo: ['mezzo', '메조']
  };
  function guessPart(fileName, parts) {
    var n = fileName.toLowerCase();
    if (/(^|[^a-z])(mix|mixed|full|all|tutti)([^a-z]|$)|전체|합창|믹스/.test(n)) return 'all';
    var best = null, bestLen = 0;
    parts.forEach(function (p, i) {
      var pn = p.name.toLowerCase();
      var keys = [pn];
      Object.keys(ALIASES).forEach(function (k) { if (pn.indexOf(k) >= 0) keys = keys.concat(ALIASES[k]); });
      keys.forEach(function (k) {
        if (k.length >= 3 && n.indexOf(k) >= 0 && k.length > bestLen) { best = String(i); bestLen = k.length; }
      });
    });
    return best === null ? 'all' : best;
  }

  // ---------------- 곡 추가 ----------------
  $('addSongBtn').onclick = function () { $('filePick').value = ''; $('filePick').click(); };
  $('filePick').onchange = function () {
    var files = Array.prototype.slice.call(this.files || []);
    if (!files.length) return;
    var midi = files.filter(isMidi)[0];
    if (!midi) { toast('MIDI 파일(.mid)을 함께 골라 주세요'); return; }
    var audios = files.filter(function (f) { return f !== midi && !isMidi(f); });
    readBuffer(midi).then(function (buf) {
      var a;
      try { a = Midi2Xml.analyze(buf); } catch (e) { toast('MIDI를 읽지 못했습니다: ' + e.message, 4000); return; }
      var song = {
        id: uid(), title: a.title || baseName(midi.name), midiName: midi.name, midi: buf,
        tracks: audios.map(function (f) {
          return { id: uid(), name: baseName(f.name), blob: f, part: guessPart(f.name, a.parts), offset: null };
        }),
        createdAt: Date.now()
      };
      return SongStore.put(song).then(function () { openSong(song.id); });
    }).catch(function (e) { toast('저장하지 못했습니다: ' + e.message, 4000); });
  };

  $('addAudioBtn').onclick = function () { $('audioPick').value = ''; $('audioPick').click(); };
  $('audioPick').onchange = function () {
    var files = Array.prototype.slice.call(this.files || []);
    if (!files.length || !state.song) return;
    files.forEach(function (f) {
      state.song.tracks.push({ id: uid(), name: baseName(f.name), blob: f, part: guessPart(f.name, state.analysis.parts), offset: null });
    });
    saveSong().then(function () { renderTracks(); toast('음원 ' + files.length + '개를 추가했습니다'); });
  };

  function saveSong() { return SongStore.put(state.song).catch(function (e) { toast('저장 실패: ' + e.message, 4000); }); }

  // ---------------- 곡 열기 ----------------
  function openSong(id) {
    SongStore.get(id).then(function (song) {
      if (!song) { toast('곡을 찾지 못했습니다'); return; }
      state.song = song;
      state.analysis = Midi2Xml.analyze(song.midi, { lyrics: song.lyrics });
      var ev = state.analysis.events, mx = 0;
      ev.forEach(function (e) { if (e.endTick - e.startTick > mx) mx = e.endTick - e.startTick; });
      state.maxDurTick = mx;
      $('songTitle').textContent = song.title;
      showSong();
      state.track = null;
      if (!song.hlPart) song.hlPart = 'all';
      renderTracks();
      renderParts();
      var first = song.tracks[0];
      return renderScore(true).then(function () { if (first) selectTrack(first.id); });
    }).catch(function (e) { toast('곡을 열지 못했습니다: ' + e.message, 5000); console.error(e); });
  }

  // ---------------- 음원 칩(음원이 2개 이상일 때만 보임) ----------------
  function renderTracks() {
    var bar = $('trackBar');
    bar.innerHTML = '';
    var tracks = state.song.tracks;
    if (!tracks.length) {
      var p = document.createElement('span');
      p.className = 'hint';
      p.textContent = '음원이 없습니다. ⋯ 메뉴에서 음원을 추가하세요.';
      bar.appendChild(p);
      bar.classList.remove('hidden');
      return;
    }
    bar.classList.toggle('hidden', tracks.length < 2);
    tracks.forEach(function (t) {
      var chip = document.createElement('button');
      chip.className = 'chip' + (state.track && state.track.id === t.id ? ' on' : '');
      chip.textContent = '♪ ' + (t.name.length > 24 ? '…' + t.name.slice(-22) : t.name);
      chip.onclick = function () { selectTrack(t.id); };
      bar.appendChild(chip);
    });
  }

  // ---------------- 하이라이트 파트 선택 ----------------
  function renderParts() {
    var bar = $('partBar');
    bar.innerHTML = '';
    var cur = state.song.hlPart || 'all';
    var items = [{ v: 'all', label: '전체' }].concat(state.analysis.parts.map(function (p, i) { return { v: String(i), label: p.name }; }));
    items.forEach(function (it) {
      var chip = document.createElement('button');
      chip.className = 'chip' + (cur === it.v ? ' on' : '');
      chip.textContent = it.label;
      chip.onclick = function () { selectPart(it.v); };
      bar.appendChild(chip);
    });
  }

  function selectPart(v) {
    state.song.hlPart = v;
    saveSong();
    renderParts();
    clearHighlight();
    if (state.view === 'mine' || state.lyrics === 'sel') renderScore(false).then(updateHighlight);
    else updateHighlight();
  }

  function hlParts() {
    var n = state.analysis.parts.length, set = new Set();
    var v = state.song && state.song.hlPart ? state.song.hlPart : 'all';
    if (v === 'all' || +v >= n) { for (var i = 0; i < n; i++) set.add(i); }
    else set.add(+v);
    return set;
  }

  function selectTrack(id) {
    var t = state.song.tracks.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var wasPlaying = !player.paused;
    var pos = player.currentTime - (state.track ? (state.track.offset || 0) : 0);
    pause();
    state.track = t;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(t.blob);
    player.src = state.objectUrl;
    player.playbackRate = parseFloat($('speedSel').value);
    player.preservesPitch = true;
    player.webkitPreservesPitch = true; // 아이폰 Safari
    renderTracks();
    $('offsetInput').value = (t.offset || 0).toFixed(2);
    clearHighlight();
    Promise.resolve().then(function () {
      if (t.offset === null || t.offset === undefined) { toast('음원 시작 위치를 맞추는 중…', 4000); autoSync(t, true); }
      var go = function () {
        if (pos > 0) player.currentTime = Math.max(0, pos + (t.offset || 0));
        if (wasPlaying) play();
        player.removeEventListener('loadedmetadata', go);
      };
      player.addEventListener('loadedmetadata', go);
    });
  }

  // ---------------- 악보 그리기 ----------------
  function renderScore(newSong, keepPage) {
    var keep = keepPage ? { page: currentPage(), top: wrap.scrollTop } : null;
    $('loading').classList.remove('hidden');
    return new Promise(function (r) { setTimeout(r, 30); }).then(function () {
      if (!state.osmd) {
        state.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('score', {
          autoResize: false, backend: 'svg', drawTitle: true, drawSubtitle: false, drawComposer: false,
          drawCredits: false, drawPartNames: true, drawMeasureNumbers: true,
          autoGenerateMultipleRestMeasuresFromRestMeasures: false, followCursor: false, disableCursor: true
        });
      }
      var osmd = state.osmd;
      var lyricKey = state.song.id + '|' + lyricPartsKey() + '|' + state.lyricVer;
      var load = (newSong || state.loadedKey !== lyricKey)
        ? osmd.load(xmlWithLyrics()).then(function () { state.loadedKey = lyricKey; state.loadedSongId = state.song.id; })
        : Promise.resolve();
      return load.then(function () {
        var show = hlParts();
        osmd.Sheet.Instruments.forEach(function (inst, i) { inst.Visible = state.view === 'all' || show.has(i); });
        osmd.Zoom = state.zoom;
        var paged = state.layout === 'page';
        wrap.classList.toggle('paged', paged);
        $('score').classList.toggle('paged', paged);
        if (paged) {
          // 페이지 하나 = 악보 화면 하나. 가로세로 비율만 쓰인다.
          state.pageW = wrap.clientWidth;
          state.pageH = wrap.clientHeight;
          osmd.setCustomPageFormat(state.pageW, state.pageH);
        } else {
          osmd.setPageFormat('Endless');
        }
        tightenRules(osmd.EngravingRules, paged);
        osmd.render();
        buildMap();
        wrap.scrollLeft = 0; wrap.scrollTop = 0;
        state.page = 0;
        if (keep) {
          if (paged) wrap.scrollLeft = Math.min(keep.page, pageCount() - 1) * state.pageW;
          else wrap.scrollTop = keep.top;
        }
        updatePageInfo();
        $('zoomVal').textContent = Math.round(state.zoom * 100) + '%';
      });
    }).catch(function (e) {
      toast('악보를 그리지 못했습니다: ' + e.message, 5000); console.error(e);
    }).then(function () { $('loading').classList.add('hidden'); });
  }

  // 가사: sel(선택 파트만, 전체 선택이면 모든 파트) | all | none
  function lyricPartsKey() {
    if (state.editLyrics) return 'all'; // 가사 편집 중에는 모든 파트 가사를 보여 준다
    if (state.lyrics === 'none') return 'none';
    if (state.lyrics === 'all') return 'all';
    var v = state.song.hlPart || 'all';
    return v === 'all' ? 'all' : 'p' + v;
  }
  function xmlWithLyrics() {
    var key = lyricPartsKey(), xml = state.analysis.xml;
    if (key === 'all') return xml;
    var keep = key === 'none' ? -1 : +key.slice(1);
    return xml.replace(/<part id="P(\d+)">[\s\S]*?<\/part>/g, function (block, n) {
      return (+n - 1) === keep ? block : block.replace(/<lyric\b[\s\S]*?<\/lyric>/g, '');
    });
  }

  // 한 화면에 마디가 더 들어가도록 여백·간격을 줄인다
  function tightenRules(r, paged) {
    function set(k, v) { if (k in r) r[k] = v; }
    set('PageTopMargin', paged ? 2 : 5);
    set('PageBottomMargin', paged ? 1 : 5);
    set('PageLeftMargin', 2);
    set('PageRightMargin', 2);
    set('TitleTopDistance', 2);
    set('TitleBottomDistance', 0.5);
    set('StaffDistance', 5);
    set('BetweenStaffDistance', 4);
    set('MinSkyBottomDistBetweenSystems', 3);
    set('MinimumDistanceBetweenSystems', 2);
  }

  // 페이지 방식: 각 페이지 div의 순번
  function pageOf(el) {
    var n = el;
    while (n && n !== document.body) {
      if (n.id && n.id.indexOf('osmdSvgPage') === 0) return (parseInt(n.id.slice(11), 10) || 1) - 1;
      n = n.parentNode;
    }
    return 0;
  }
  function pageCount() { return $('score').querySelectorAll('[id^="osmdSvgPage"]').length || 1; }
  function currentPage() { return state.pageW ? Math.round(wrap.scrollLeft / state.pageW) : 0; }
  function updatePageInfo() {
    var info = $('pageInfo');
    if (state.layout !== 'page') { info.classList.add('hidden'); return; }
    info.classList.remove('hidden');
    info.textContent = (currentPage() + 1) + ' / ' + pageCount();
  }
  // 페이지는 미끄러지지 않고 바로 바뀐다
  function goPage(n) {
    n = Math.max(0, Math.min(pageCount() - 1, n));
    wrap.scrollLeft = n * state.pageW;
    updatePageInfo();
  }
  // 손가락으로 좌우로 밀면 한 장씩 바로 넘긴다(누른 뒤 4초 동안은 자동 넘김을 멈춤)
  var touchX = null, touchY = 0;
  wrap.addEventListener('touchstart', function (e) {
    if (state.layout !== 'page' || e.touches.length !== 1) { touchX = null; return; }
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }, { passive: true });
  wrap.addEventListener('touchend', function (e) {
    if (touchX === null || state.layout !== 'page') return;
    var t = e.changedTouches[0], dx = t.clientX - touchX, dy = t.clientY - touchY;
    touchX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      state.userScrollUntil = Date.now() + 4000;
      goPage(currentPage() + (dx < 0 ? 1 : -1));
    }
  }, { passive: true });
  document.addEventListener('keydown', function (e) {
    if (state.layout !== 'page' || $('songView').classList.contains('hidden')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { state.userScrollUntil = Date.now() + 4000; goPage(currentPage() + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { state.userScrollUntil = Date.now() + 4000; goPage(currentPage() - 1); }
    else if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
  });

  function buildMap() {
    var osmd = state.osmd, a = state.analysis;
    var insts = osmd.Sheet.Instruments;
    var lookup = new Map();
    state.active = new Set();
    state.elToEvent = new Map();
    osmd.GraphicSheet.MeasureList.forEach(function (row) {
      (row || []).forEach(function (gm) {
        if (!gm || !gm.parentSourceMeasure) return;
        var mi = gm.parentSourceMeasure.measureListIndex;
        var pi = insts.indexOf(gm.ParentStaff.ParentInstrument);
        gm.staffEntries.forEach(function (se) {
          var pos = Math.round(se.relInMeasureTimestamp.RealValue * 4 * Midi2Xml.DIV);
          se.graphicalVoiceEntries.forEach(function (gve) {
            gve.notes.forEach(function (gn) {
              if (!gn.sourceNote || gn.sourceNote.isRest()) return;
              var g = gn.getSVGGElement ? gn.getSVGGElement() : null;
              if (!g) return;
              var k = pi + '|' + mi + '|' + pos;
              var arr = lookup.get(k);
              if (!arr) lookup.set(k, arr = []);
              if (arr.indexOf(g) < 0) arr.push(g);
            });
          });
        });
      });
    });
    var miss = 0;
    state.eventEls = a.events.map(function (e, i) {
      var els = lookup.get(e.part + '|' + e.measure + '|' + e.pos) || [];
      if (!els.length) miss++;
      els.forEach(function (g) { if (!state.elToEvent.has(g)) state.elToEvent.set(g, i); });
      return els;
    });
    window.__scoreStats = { events: a.events.length, matched: a.events.length - miss, groups: lookup.size };
    if (miss && state.view === 'all') console.warn('악보에서 찾지 못한 음표 조각', miss, '/', a.events.length);
  }

  // ---------------- 하이라이트 ----------------
  function clearHighlight() {
    state.active.forEach(function (i) { (state.eventEls[i] || []).forEach(function (g) { g.classList.remove('hl'); }); });
    state.active = new Set();
  }

  function currentTick() {
    var off = state.track ? (state.track.offset || 0) : 0;
    return state.analysis.secToTick(player.currentTime - off);
  }

  function updateHighlight() {
    if (!state.analysis) return;
    var ev = state.analysis.events;
    var tick = currentTick();
    var parts = hlParts();
    // startTick <= tick 인 마지막 위치를 이진 탐색
    var lo = 0, hi = ev.length - 1, last = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (ev[mid].startTick <= tick) { last = mid; lo = mid + 1; } else hi = mid - 1; }
    var next = new Set();
    for (var j = last; j >= 0 && ev[j].startTick > tick - state.maxDurTick - 1; j--) {
      if (ev[j].endTick > tick && parts.has(ev[j].part)) next.add(j);
    }
    var changed = false;
    state.active.forEach(function (i) {
      if (!next.has(i)) { (state.eventEls[i] || []).forEach(function (g) { g.classList.remove('hl'); }); changed = true; }
    });
    next.forEach(function (i) {
      if (!state.active.has(i)) { (state.eventEls[i] || []).forEach(function (g) { g.classList.add('hl'); }); changed = true; }
    });
    state.active = next;
    if (changed && next.size) autoScroll(next);
  }

  function autoScroll(set) {
    if (!$('autoScroll').checked || Date.now() < state.userScrollUntil) return;
    if (state.layout === 'page') {
      // 선택 파트의 현재 음표가 다른 페이지로 넘어갔을 때만 넘긴다
      var target = Infinity;
      set.forEach(function (i) { (state.eventEls[i] || []).forEach(function (g) { target = Math.min(target, pageOf(g)); }); });
      if (target !== Infinity && target !== currentPage()) goPage(target);
      return;
    }
    var top = Infinity, bottom = -Infinity;
    set.forEach(function (i) {
      (state.eventEls[i] || []).forEach(function (g) {
        var r = g.getBoundingClientRect();
        if (r.height === 0 && r.width === 0) return;
        top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
      });
    });
    if (top === Infinity) return;
    var wr = wrap.getBoundingClientRect();
    var margin = Math.min(80, wrap.clientHeight * 0.15);
    if (top < wr.top + margin || bottom > wr.bottom - margin) {
      var target = wrap.scrollTop + (top - wr.top) - wrap.clientHeight * 0.25;
      wrap.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }
  ['touchstart', 'wheel', 'mousedown'].forEach(function (evName) {
    wrap.addEventListener(evName, function () { state.userScrollUntil = Date.now() + 4000; }, { passive: true });
  });

  // ---------------- 재생 ----------------
  var raf = 0;
  function loop() {
    updateHighlight();
    updateTimeUi();
    raf = requestAnimationFrame(loop);
  }
  function play() {
    if (!state.track) { toast('재생할 음원이 없습니다. ⋯ 메뉴에서 음원을 추가하세요.'); return; }
    var p = player.play();
    if (p && p.catch) p.catch(function (e) { toast('재생하지 못했습니다: ' + e.message); });
  }
  function pause() { player.pause(); }
  player.addEventListener('play', function () { $('playBtn').textContent = '❚❚'; cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
  player.addEventListener('pause', function () { $('playBtn').textContent = '▶'; cancelAnimationFrame(raf); updateHighlight(); updateTimeUi(); });
  player.addEventListener('ended', function () { $('playBtn').textContent = '▶'; });
  player.addEventListener('loadedmetadata', function () { updateTimeUi(); });
  player.addEventListener('seeked', function () { updateHighlight(); updateTimeUi(); });

  var seeking = false;
  function updateTimeUi() {
    var d = player.duration || 0;
    $('curTime').textContent = fmt(player.currentTime);
    $('durTime').textContent = fmt(d);
    if (!seeking && d) $('seek').value = Math.round(player.currentTime / d * 1000);
  }
  $('seek').addEventListener('input', function () {
    seeking = true;
    var d = player.duration || 0;
    if (d) { player.currentTime = this.value / 1000 * d; updateHighlight(); $('curTime').textContent = fmt(player.currentTime); }
  });
  $('seek').addEventListener('change', function () { seeking = false; });

  $('playBtn').onclick = function () { if (player.paused) play(); else pause(); };
  $('back5').onclick = function () { player.currentTime = Math.max(0, player.currentTime - 5); };
  $('fwd5').onclick = function () { player.currentTime = Math.min(player.duration || 0, player.currentTime + 5); };
  $('speedSel').onchange = function () { player.playbackRate = parseFloat(this.value); };

  // 음표를 누르면 그 위치로 이동, 싱크 모드면 지금 들리는 소리를 그 음표에 맞춘다
  $('score').addEventListener('click', function (e) {
    var g = e.target.closest ? e.target.closest('g') : null;
    var idx;
    while (g && g.id !== 'score') {
      if (state.elToEvent.has(g)) { idx = state.elToEvent.get(g); break; }
      g = g.parentNode;
    }
    if (idx === undefined) return;
    if (state.editLyrics) { editNoteLyric(idx); return; }
    if (!state.track) return;
    var ev = state.analysis.events[idx];
    var sec = state.analysis.tickToSec(ev.startTick);
    if (state.syncMode) {
      state.track.offset = player.currentTime - sec;
      state.syncMode = false;
      $('tapBtn').classList.remove('primary');
      $('offsetInput').value = state.track.offset.toFixed(2);
      saveSong();
      toast('시작 위치를 ' + state.track.offset.toFixed(2) + '초로 맞췄습니다');
      updateHighlight();
      return;
    }
    player.currentTime = Math.max(0, sec + (state.track.offset || 0) - 0.03);
  });

  // ---------------- 가사 수동 변경 ----------------
  // 고친 가사는 song.lyrics[파트][음표위치 q] = '가사'로 저장한다. 끝이 '-'면 다음 음절로 이어지는 말, ''이면 가사 없음.
  function lyricToText(l) { return l ? l.text + (l.syllabic === 'begin' || l.syllabic === 'middle' ? '-' : '') : ''; }
  function headEventsOf(part) {
    return state.analysis.events.filter(function (e) { return e.head && e.part === part; })
      .sort(function (a, b) { return a.q - b.q; });
  }
  function applyLyricChange(msg) {
    saveSong();
    state.analysis = Midi2Xml.analyze(state.song.midi, { lyrics: state.song.lyrics });
    state.lyricVer++;
    return renderScore(false, true).then(function () { updateHighlight(); if (msg) toast(msg); });
  }
  function editNoteLyric(idx) {
    var ev = state.analysis.events[idx];
    // 붙임줄로 이어진 뒤 조각을 눌렀으면 그 음의 첫 조각으로
    if (!ev.head) {
      var heads = headEventsOf(ev.part).filter(function (h) { return h.startTick <= ev.startTick; });
      ev = heads[heads.length - 1];
      if (!ev) return;
    }
    var partName = state.analysis.parts[ev.part].name;
    var cur = lyricToText(ev.lyric);
    var v = window.prompt(partName + ' ' + (ev.measure + (state.analysis.pickup > 0 ? 0 : 1)) + '마디 가사\n(다음 음절로 이어지면 끝에 -, 비우면 가사 없음)', cur);
    if (v === null) return;
    v = v.trim();
    if (v === cur) return;
    var L = state.song.lyrics || (state.song.lyrics = {});
    (L[ev.part] = L[ev.part] || {})[ev.q] = v;
    applyLyricChange('가사를 바꿨습니다');
  }
  function setEditLyrics(on) {
    state.editLyrics = on;
    $('editBanner').classList.toggle('hidden', !on);
    if (on) pause();
    renderScore(false, true).then(updateHighlight);
  }
  $('editLyricsBtn').onclick = function () { $('panel').classList.add('hidden'); setEditLyrics(true); };
  $('editDoneBtn').onclick = function () { setEditLyrics(false); };

  // 파트 가사 통째로 입력: 띄어쓰기로 단어, '-'로 음절, '_'는 가사 없는 음(늘임). 한글 단어는 글자마다 한 음절.
  function splitLyrics(text) {
    var out = [];
    text.split(/\s+/).forEach(function (tok) {
      if (!tok) return;
      if (/^_+$/.test(tok)) { for (var i = 0; i < tok.length; i++) out.push(''); return; }
      var syl = tok.split('-').filter(function (s) { return s !== ''; });
      if (syl.length === 1 && /[가-힣]/.test(tok) && tok.length > 1 && !/-/.test(tok)) syl = Array.from(tok);
      syl.forEach(function (s, i) {
        if (/^_+$/.test(s)) { out.push(''); return; }
        out.push(i < syl.length - 1 ? s + '-' : s);
      });
    });
    return out;
  }
  function currentPartText(part) {
    // 단어마다 음절 조각을 모아, 모두 한글 한 글자면 붙여 쓰고(글자마다 음절로 다시 나뉨) 아니면 '-'로 잇는다
    var words = [], pieces = [];
    function flush() {
      if (!pieces.length) return;
      var allSingleHangul = pieces.every(function (p) { return /^[가-힣]$/.test(p); });
      words.push(pieces.join(allSingleHangul && pieces.length > 1 ? '' : '-'));
      pieces = [];
    }
    headEventsOf(part).forEach(function (e) {
      var l = e.lyric;
      if (!l) { flush(); words.push('_'); return; }
      if (l.syllabic === 'begin' || l.syllabic === 'single') flush();
      pieces.push(l.text);
      if (l.syllabic === 'single' || l.syllabic === 'end') flush();
    });
    flush();
    // 끝쪽의 가사 없는 음은 생략
    while (words.length && words[words.length - 1] === '_') words.pop();
    return words.join(' ');
  }
  function openLyricDialog() {
    var sel = $('lyricPartSel');
    sel.innerHTML = '';
    state.analysis.parts.forEach(function (p, i) {
      var o = document.createElement('option'); o.value = String(i); o.textContent = p.name; sel.appendChild(o);
    });
    var hp = state.song.hlPart && state.song.hlPart !== 'all' ? state.song.hlPart : '0';
    sel.value = hp;
    $('lyricText').value = currentPartText(+sel.value);
    $('panel').classList.add('hidden');
    $('lyricDialog').classList.remove('hidden');
  }
  $('lyricPartSel').onchange = function () { $('lyricText').value = currentPartText(+this.value); };
  $('lyricAllBtn').onclick = openLyricDialog;
  $('lyricCancel').onclick = function () { $('lyricDialog').classList.add('hidden'); };
  $('lyricApply').onclick = function () {
    var part = +$('lyricPartSel').value;
    var syl = splitLyrics($('lyricText').value);
    var heads = headEventsOf(part);
    var map = {};
    heads.forEach(function (e, i) { map[e.q] = i < syl.length ? syl[i] : ''; });
    var L = state.song.lyrics || (state.song.lyrics = {});
    L[part] = map;
    $('lyricDialog').classList.add('hidden');
    var extra = syl.length - heads.length;
    applyLyricChange(extra > 0 ? '가사를 넣었습니다. 음표보다 음절이 ' + extra + '개 많아 뒤쪽은 빠졌습니다'
      : syl.length < heads.length ? '가사를 넣었습니다(음표 ' + heads.length + '개 중 ' + syl.length + '개)' : '가사를 넣었습니다');
  };
  $('lyricReset').onclick = function () {
    var part = +$('lyricPartSel').value;
    if (!confirm(state.analysis.parts[part].name + ' 파트 가사를 MIDI 원래 가사로 되돌릴까요?')) return;
    if (state.song.lyrics) delete state.song.lyrics[part];
    $('lyricDialog').classList.add('hidden');
    applyLyricChange('원래 가사로 되돌렸습니다');
  };

  $('tapBtn').onclick = function () {
    state.syncMode = !state.syncMode;
    this.classList.toggle('primary', state.syncMode);
    if (state.syncMode) toast('재생하면서, 지금 들리는 음표를 악보에서 누르세요', 3500);
  };

  // ---------------- 시작 위치 자동 맞춤 ----------------
  // 음원 첫 소리는 카운트인(메트로놈)일 수 있어 믿지 않는다.
  // 1) 음원과 MIDI의 음 높이 분포(크로마)를 곡 전체에서 비교해 어긋난 시간을 0.05초 단위로 찾고
  // 2) 그 근처 ±0.1초에서 음 시작(세기 증가) 위치를 맞춰 0.01초 단위로 다듬는다.
  function fftInPlace(re, im) {
    var n = re.length, i, j = 0, bit, len, t;
    for (i = 1; i < n; i++) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (i = 0; i < n; i += len) {
        var ur = 1, ui = 0;
        for (j = 0; j < half; j++) {
          var a = i + j, b = a + half;
          var tr = re[b] * ur - im[b] * ui, ti = re[b] * ui + im[b] * ur;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          var nr = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = nr;
        }
      }
    }
  }

  function estimateOffset(ab, analysis, partSet) {
    var sr = ab.sampleRate, c0 = ab.getChannelData(0), c1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : c0;
    var HOP = 0.05, N = 4096, nA = Math.max(0, Math.floor((c0.length - N) / (sr * HOP)));
    var win = new Float32Array(N), k, f;
    for (k = 0; k < N; k++) win[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N);
    var binPc = new Int8Array(N / 2);
    for (k = 0; k < N / 2; k++) {
      var fr = k * sr / N;
      binPc[k] = (fr < 60 || fr > 2000) ? -1 : (((Math.round(69 + 12 * Math.log2(fr / 440)) % 12) + 12) % 12);
    }
    var A = new Float32Array(nA * 12), re = new Float32Array(N), im = new Float32Array(N);
    for (f = 0; f < nA; f++) {
      var s0 = Math.round(f * HOP * sr);
      for (k = 0; k < N; k++) { re[k] = (c0[s0 + k] + c1[s0 + k]) * 0.5 * win[k]; im[k] = 0; }
      fftInPlace(re, im);
      var base = f * 12, nn = 0;
      for (k = 1; k < N / 2; k++) if (binPc[k] >= 0) A[base + binPc[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      for (k = 0; k < 12; k++) nn += A[base + k] * A[base + k];
      nn = Math.sqrt(nn) || 1;
      for (k = 0; k < 12; k++) A[base + k] /= nn;
    }
    // MIDI 크로마(선택 파트는 3배 가중)
    var nM = Math.ceil(analysis.tickToSec(analysis.endTick) / HOP) + 1;
    var M = new Float32Array(nM * 12);
    analysis.events.forEach(function (e) {
      var w = partSet.has(e.part) ? 3 : 1;
      var s = Math.floor(analysis.tickToSec(e.startTick) / HOP), en = Math.floor(analysis.tickToSec(e.endTick) / HOP);
      for (var q = s; q <= en && q < nM; q++) (e.keys || []).forEach(function (key) { M[q * 12 + key % 12] += w; });
    });
    var active = [];
    for (f = 0; f < nM; f++) {
      var nm = 0;
      for (k = 0; k < 12; k++) nm += M[f * 12 + k] * M[f * 12 + k];
      if (nm > 0) { nm = Math.sqrt(nm); for (k = 0; k < 12; k++) M[f * 12 + k] /= nm; active.push(f); }
    }
    var bestO = 0, bestS = -1;
    var maxLag = Math.min(Math.round(40 / HOP), nA), minLag = -Math.round(10 / HOP);
    for (var lag = minLag; lag <= maxLag; lag++) {
      var sc = 0, cnt = 0;
      for (var ai = 0; ai < active.length; ai++) {
        var mf = active[ai], af = mf + lag;
        if (af < 0 || af >= nA) continue;
        var d = 0;
        for (k = 0; k < 12; k++) d += M[mf * 12 + k] * A[af * 12 + k];
        sc += d; cnt++;
      }
      if (cnt < active.length * 0.6) continue;
      sc /= cnt;
      if (sc > bestS) { bestS = sc; bestO = lag * HOP; }
    }
    // 음 시작 위치로 다듬기
    var hop = Math.round(sr * 0.01), n = Math.floor(c0.length / hop), env = new Float32Array(n);
    for (f = 0; f < n; f++) {
      var e2 = 0;
      for (k = f * hop; k < (f + 1) * hop; k++) e2 += c0[k] * c0[k];
      env[f] = Math.log(Math.sqrt(e2 / hop) + 1e-4);
    }
    var od = new Float32Array(n);
    for (f = 1; f < n; f++) od[f] = Math.max(0, env[f] - env[f - 1]);
    var onsets = analysis.events.filter(function (e) { return e.head; }).map(function (e) { return analysis.tickToSec(e.startTick); });
    var fine = bestO, fineS = -1;
    for (var o = bestO - 0.1; o <= bestO + 0.1001; o += 0.01) {
      var s2 = 0;
      onsets.forEach(function (t) { var q = Math.round((t + o) * 100); if (q > 0 && q < n) s2 += od[q] + 0.5 * ((od[q - 1] || 0) + (od[q + 1] || 0)); });
      if (s2 > fineS) { fineS = s2; fine = o; }
    }
    return { offset: Math.round(fine * 100) / 100, score: bestS };
  }

  function autoSync(track, verbose) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    var parts = (function () { var s = new Set(); if (track.part === 'all') state.analysis.parts.forEach(function (p, i) { s.add(i); }); else s.add(+track.part); return s; })();
    var analysis = state.analysis;
    readBuffer(track.blob).then(function (buf) {
      var ctx = new Ctx();
      return new Promise(function (res, rej) { ctx.decodeAudioData(buf, res, rej); }).then(function (ab) {
        if (ctx.close) ctx.close();
        var r = estimateOffset(ab, analysis, parts);
        track.offset = r.offset;
        if (state.track === track) { $('offsetInput').value = track.offset.toFixed(2); updateHighlight(); }
        saveSong();
        if (verbose) toast('시작 위치를 ' + track.offset.toFixed(2) + '초로 맞췄습니다');
      });
    }).catch(function (e) {
      if (track.offset === null || track.offset === undefined) track.offset = 0;
      if (verbose) toast('자동 맞춤 실패: ' + e.message);
    });
  }

  // ---------------- 설정 패널 ----------------
  $('layoutSel').onchange = function () {
    state.layout = this.value;
    try { localStorage.setItem('layout', state.layout); } catch (e) { /* 무시 */ }
    renderScore(false).then(updateHighlight);
  };
  $('lyricSel').onchange = function () {
    state.lyrics = this.value;
    try { localStorage.setItem('lyrics', state.lyrics); } catch (e) { /* 무시 */ }
    renderScore(false).then(updateHighlight);
  };
  $('menuBtn').onclick = function () {
    $('lyricSel').value = state.lyrics;
    $('layoutSel').value = state.layout;
    $('viewSel').value = state.view;
    $('offsetInput').value = state.track ? (state.track.offset || 0).toFixed(2) : '0.00';
    var a = state.analysis;
    $('songInfo').textContent = 'MIDI: ' + state.song.midiName + ' · 파트 ' + a.parts.map(function (p) { return p.name; }).join(', ') +
      ' · 템포 ' + a.bpm + ' · ' + a.measures.length + '마디 · ' + fmt(a.tickToSec(a.endTick));
    $('panel').classList.remove('hidden');
  };
  $('closePanel').onclick = function () { $('panel').classList.add('hidden'); };
  $('panel').onclick = function (e) { if (e.target === this) this.classList.add('hidden'); };
  $('viewSel').onchange = function () {
    state.view = this.value;
    try { localStorage.setItem('view', state.view); } catch (e) { /* 무시 */ }
    renderScore(false);
  };
  function setZoom(z) {
    state.zoom = Math.max(0.3, Math.min(2, Math.round(z * 10) / 10));
    try { localStorage.setItem('zoom', state.zoom); } catch (e) { /* 무시 */ }
    renderScore(false);
  }
  $('zoomIn').onclick = function () { setZoom(state.zoom + 0.1); };
  $('zoomOut').onclick = function () { setZoom(state.zoom - 0.1); };
  function setOffset(v) {
    if (!state.track) return;
    state.track.offset = Math.round(v * 100) / 100;
    $('offsetInput').value = state.track.offset.toFixed(2);
    saveSong(); updateHighlight();
  }
  $('offMinus').onclick = function () { setOffset((state.track ? state.track.offset || 0 : 0) - 0.05); };
  $('offPlus').onclick = function () { setOffset((state.track ? state.track.offset || 0 : 0) + 0.05); };
  $('offsetInput').onchange = function () { var v = parseFloat(this.value); if (isFinite(v)) setOffset(v); };
  $('autoSyncBtn').onclick = function () { if (state.track) { toast('음원을 분석하는 중…'); autoSync(state.track, true); } };
  $('deleteSongBtn').onclick = function () {
    if (!confirm('"' + state.song.title + '" 곡을 삭제할까요? 폰에 저장한 MIDI와 음원이 지워집니다.')) return;
    SongStore.remove(state.song.id).then(function () { $('panel').classList.add('hidden'); state.song = null; showList(); });
  };
  $('backBtn').onclick = showList;

  // 화면 회전 등으로 폭이 바뀌면 다시 그린다
  var lastW = window.innerWidth, lastH = window.innerHeight, rt = 0;
  window.addEventListener('resize', function () {
    var dw = Math.abs(window.innerWidth - lastW), dh = Math.abs(window.innerHeight - lastH);
    if ((dw < 40 && (state.layout !== 'page' || dh < 60)) || !state.song || $('songView').classList.contains('hidden')) return;
    lastW = window.innerWidth; lastH = window.innerHeight;
    clearTimeout(rt);
    rt = setTimeout(function () { renderScore(false); }, 400);
  });

  // 아이폰: 파일 선택 창에서 .mid가 흐리게 막히지 않도록 형식 제한을 푼다
  var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) { $('filePick').removeAttribute('accept'); }

  // 웹앱(아이폰 홈 화면 등): 오프라인 캐시 등록, 저장한 곡이 지워지지 않게 요청
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isNative && 'serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('서비스 워커 등록 실패', e); });
  }
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () { /* 무시 */ }); }

  // 안드로이드 뒤로 가기 버튼
  var Cap = window.Capacitor;
  if (Cap && Cap.Plugins && Cap.Plugins.App) {
    Cap.Plugins.App.addListener('backButton', function () {
      if (!$('panel').classList.contains('hidden')) $('panel').classList.add('hidden');
      else if (!$('songView').classList.contains('hidden')) showList();
      else Cap.Plugins.App.exitApp();
    });
  }

  // 시험용: ?demo=1 이면 sample/ 폴더의 score.mid와 음원을 불러온다(PC 확인용)
  window.__app = { state: state, openSong: openSong, selectTrack: selectTrack, updateHighlight: updateHighlight };
  if (/[?&]demo=1/.test(location.search)) {
    Promise.all([fetch('sample/score.mid').then(function (r) { return r.arrayBuffer(); }),
      fetch('sample/Tenor.mp3').then(function (r) { return r.blob(); })]).then(function (res) {
      var a = Midi2Xml.analyze(res[0]);
      var song = { id: 'demo', title: a.title, midiName: 'score.mid', midi: res[0],
        tracks: [{ id: 'demo-t', name: 'We_Wish_You_A_Merry_Chritmas_Tenor', blob: res[1], part: guessPart('Tenor.mp3', a.parts), offset: null }], createdAt: Date.now() };
      return SongStore.put(song).then(function () { openSong('demo'); });
    }).catch(function (e) { toast('데모 불러오기 실패: ' + e.message); });
  } else {
    renderSongList();
  }
})();
