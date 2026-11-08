/* 악보 하이라이트 앱 본체 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var audioEl = $('player');
  var midiPlayer = new MidiPlayer();
  var player = audioEl;           // 지금 쓰는 재생기(mp3 = audioEl, MIDI 소리 = midiPlayer)
  var MIDI_TRACK_ID = '__midi';
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
    loop: null,         // { ma, mb, a, b } 구간 반복(마디 번호, 악보 초)
    loopStep: 0,        // 1: 시작 마디 고르는 중, 2: 끝 마디 고르는 중
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
    var zip = files.filter(function (f) { return /\.zip$/i.test(f.name); })[0];
    if (zip) { importPack(zip); return; }
    var midi = files.filter(isMidi)[0];
    if (!midi) { toast('MIDI 파일(.mid) 또는 곡 묶음(.zip)을 골라 주세요', 3500); return; }
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
    return SongStore.get(id).then(function (song) {
      if (!song) { toast('곡을 찾지 못했습니다'); return; }
      state.song = song;
      state.analysis = Midi2Xml.analyze(song.midi, { lyrics: song.lyrics });
      var ev = state.analysis.events, mx = 0;
      ev.forEach(function (e) { if (e.endTick - e.startTick > mx) mx = e.endTick - e.startTick; });
      state.maxDurTick = mx;
      $('songTitle').textContent = song.title;
      showSong();
      state.track = null;
      state.loop = null; state.loopStep = 0; updateLoopBtn();
      if (!song.hlPart) song.hlPart = 'all';
      if (!song.mix || !song.mix.vol || song.mix.vol.length !== state.analysis.parts.length) {
        song.mix = { vol: state.analysis.parts.map(function () { return 0.8; }), mute: state.analysis.parts.map(function () { return false; }), transpose: 0 };
      }
      state.midiTrack = { id: MIDI_TRACK_ID, name: 'MIDI 소리', midi: true, offset: 0, part: 'all' };
      midiPlayer.load(state.analysis, effectiveVolumes(), song.mix.transpose);
      renderTracks();
      renderParts();
      var first = song.tracks[0] || state.midiTrack;
      return renderScore(true).then(function () { selectTrack(first.id); });
    }).catch(function (e) { toast('곡을 열지 못했습니다: ' + e.message, 5000); console.error(e); });
  }

  // ---------------- 음원 칩(mp3들 + MIDI 소리) ----------------
  function renderTracks() {
    var bar = $('trackBar');
    bar.innerHTML = '';
    var tracks = state.song.tracks.concat([state.midiTrack]);
    bar.classList.remove('hidden');
    tracks.forEach(function (t) {
      var chip = document.createElement('button');
      chip.className = 'chip' + (state.track && state.track.id === t.id ? ' on' : '');
      chip.textContent = (t.midi ? '🎹 ' : '♪ ') + (t.name.length > 24 ? '…' + t.name.slice(-22) : t.name);
      chip.onclick = function () { selectTrack(t.id); };
      bar.appendChild(chip);
    });
  }

  // ---------------- 버튼 줄 끌어서 옮기기 ----------------
  // 휴대폰은 손가락으로 끌면 원래 가로로 스크롤된다. 마우스(PC)로 끌어도 옮겨지게 하고,
  // 끈 뒤에 손을 뗄 때 버튼이 눌리지 않게 막는다.
  function enableDragScroll(el) {
    var down = false, startX = 0, startLeft = 0, moved = false;
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      down = true; moved = false; startX = e.clientX; startLeft = el.scrollLeft;
    });
    window.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 5) moved = true;
      if (moved) { el.scrollLeft = startLeft - dx; e.preventDefault(); }
    });
    window.addEventListener('pointerup', function () { down = false; });
    // 손가락으로 끈 경우도 클릭을 막는다(브라우저가 대부분 막지만 일부 웹뷰 대비)
    var tx = 0, tMoved = false;
    el.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; tMoved = false; }, { passive: true });
    el.addEventListener('touchmove', function (e) { if (Math.abs(e.touches[0].clientX - tx) > 8) tMoved = true; }, { passive: true });
    el.addEventListener('click', function (e) {
      if (moved || tMoved) { e.stopPropagation(); e.preventDefault(); moved = false; tMoved = false; }
    }, true);
  }
  enableDragScroll($('partBar'));
  enableDragScroll($('trackBar'));

  // ---------------- 하이라이트 파트 선택 ----------------
  function renderParts() {
    var bar = $('partBar');
    bar.innerHTML = '';
    var cur = state.song.hlPart || 'all';
    var items = [{ v: 'all', label: '전체' }].concat(state.analysis.parts.map(function (p, i) { return { v: String(i), label: p.name }; }));
    var keepScroll = bar.scrollLeft, onChip = null;
    items.forEach(function (it) {
      var chip = document.createElement('button');
      chip.className = 'chip' + (cur === it.v ? ' on' : '');
      chip.textContent = it.label;
      chip.onclick = function () { selectPart(it.v); };
      bar.appendChild(chip);
      if (cur === it.v) onChip = chip;
    });
    // 한 줄 가로 스크롤: 위치를 유지하고, 고른 버튼이 화면 밖이면 보이게
    bar.scrollLeft = keepScroll;
    if (onChip) {
      var l = onChip.offsetLeft - bar.offsetLeft, r = l + onChip.offsetWidth;
      if (l < bar.scrollLeft + 8) bar.scrollLeft = Math.max(0, l - 24);
      else if (r > bar.scrollLeft + bar.clientWidth - 8) bar.scrollLeft = r - bar.clientWidth + 24;
    }
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
    var t = id === MIDI_TRACK_ID ? state.midiTrack : state.song.tracks.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var wasPlaying = !player.paused;
    var pos = state.track ? player.currentTime - (state.track.offset || 0) : 0;
    pause();
    state.track = t;
    if (t.midi) {
      player = midiPlayer;
      player.playbackRate = parseFloat($('speedSel').value);
      renderTracks();
      $('offsetInput').value = '0.00';
      clearHighlight();
      if (pos > 0) player.currentTime = pos;
      updateTimeUi(); updateHighlight();
      if (wasPlaying) play();
      return;
    }
    player = audioEl;
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
        // 페이지 방식에서 악보 한 단(모든 파트 줄)이 화면 높이보다 크면 아래 줄이 잘린다.
        // 넘치지 않을 때까지 크기를 줄여 다시 그린다(설정한 확대값이 최대).
        state.fitZoom = state.zoom;
        if (paged) {
          for (var tries = 0; tries < 4; tries++) {
            var over = pageOverflowRatio();
            if (over <= 1.0) break;
            state.fitZoom = Math.max(0.2, state.fitZoom / over * 0.97);
            osmd.Zoom = state.fitZoom;
            osmd.setCustomPageFormat(state.pageW, state.pageH);
            osmd.render();
          }
        }
        state.lastRenderW = wrap.clientWidth;
        // 그리는 동안 크기가 또 바뀌었으면 한 번 더
        setTimeout(onWrapResize, 50);
        buildMap();
        drawLoopMarks();
        wrap.scrollLeft = 0; wrap.scrollTop = 0;
        state.page = 0;
        if (keep) {
          if (paged) wrap.scrollLeft = Math.min(keep.page, pageCount() - 1) * state.pageW;
          else wrap.scrollTop = keep.top;
        }
        updatePageInfo();
        $('zoomVal').textContent = Math.round(state.zoom * 100) + '%' +
          (state.fitZoom < state.zoom - 0.005 ? ' (화면에 맞춰 ' + Math.round(state.fitZoom * 100) + '%)' : '');
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

  // 페이지 내용(그려진 악보)의 아래 끝이 페이지 높이의 몇 배인지. 1 이하면 잘리지 않는다.
  function pageOverflowRatio() {
    var worst = 0;
    Array.prototype.forEach.call($('score').querySelectorAll('svg'), function (svg) {
      var vb = svg.viewBox && svg.viewBox.baseVal;
      if (!vb || !vb.height) return;
      var bb;
      try { bb = svg.getBBox(); } catch (e) { return; }
      var r = (bb.y + bb.height + 4) / vb.height;
      if (r > worst) worst = r;
    });
    return worst;
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
    // 글 입력 중(가사 입력 창, 숫자 칸 등)이나 설정·입력 창이 열려 있을 때는 단축키를 쓰지 않는다
    var tg = e.target, tag = tg && tg.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (tg && tg.isContentEditable)) return;
    if (document.querySelector('.panel:not(.hidden)')) return;
    if (window.Tutorial && Tutorial.isOpen()) return;
    if ($('songView').classList.contains('hidden')) return;
    if (e.key === ' ') {
      // 방금 누른 버튼에 포커스가 남아 있으면 스페이스가 그 버튼도 누르므로 포커스를 뺀다
      if (tag === 'BUTTON') tg.blur();
      e.preventDefault(); $('playBtn').click(); return;
    }
    if (state.layout !== 'page') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { state.userScrollUntil = Date.now() + 4000; goPage(currentPage() + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { state.userScrollUntil = Date.now() + 4000; goPage(currentPage() - 1); }
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

    // 마디마다 몇 번째 페이지·어느 높이에 있는지(파트와 상관없이 재생 위치로 페이지를 넘기기 위해)
    var pages = osmd.GraphicSheet.MusicPages || [];
    state.measurePos = osmd.GraphicSheet.MeasureList.map(function (row) {
      var info = null;
      (row || []).forEach(function (gm) {
        if (!gm || !gm.ParentMusicSystem || !gm.PositionAndShape) return;
        var y = gm.PositionAndShape.AbsolutePosition.y;
        if (!info) info = { page: Math.max(0, pages.indexOf(gm.ParentMusicSystem.Parent)), top: y, bottom: y + 4 };
        info.top = Math.min(info.top, y); info.bottom = Math.max(info.bottom, y + 4);
      });
      return info;
    });
    state.followMeasure = -1;
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
    followPosition(tick);
  }

  // 지금 재생 중인 마디(모든 파트 기준)를 따라 페이지를 넘긴다. 선택 파트가 쉬는 중이어도 넘어간다.
  function measureAt(tick) {
    var ms = state.analysis.measures, lo = 0, hi = ms.length - 1, ans = 0;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (ms[mid].start <= tick) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function followPosition(tick) {
    if (!state.measurePos) return;
    var m = measureAt(Math.max(0, tick));
    if (m === state.followMeasure) return;
    if (!$('autoScroll').checked || Date.now() < state.userScrollUntil) return; // 손으로 넘겨 보는 중이면 기다린다
    state.followMeasure = m;
    var info = state.measurePos[m];
    if (!info) return;
    if (state.layout === 'page') {
      if (info.page !== currentPage()) goPage(info.page);
      return;
    }
    // 위아래 스크롤: 그 마디 줄이 화면 밖이면 위쪽 1/4 지점으로
    var svg = $('score').querySelector('svg');
    if (!svg) return;
    var scale = 10 * state.zoom, sr = svg.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    var top = sr.top + (info.top - 2) * scale, bottom = sr.top + (info.bottom + 2) * scale;
    var margin = Math.min(80, wrap.clientHeight * 0.15);
    if (top < wr.top + margin || bottom > wr.bottom - margin) {
      wrap.scrollTo({ top: Math.max(0, wrap.scrollTop + (top - wr.top) - wrap.clientHeight * 0.25), behavior: 'smooth' });
    }
  }
  ['touchstart', 'wheel', 'mousedown'].forEach(function (evName) {
    wrap.addEventListener(evName, function () { state.userScrollUntil = Date.now() + 4000; }, { passive: true });
  });

  // ---------------- 재생 ----------------
  var raf = 0;
  function loop() {
    checkLoop();
    updateHighlight();
    updateTimeUi();
    raf = requestAnimationFrame(loop);
  }
  // 화면이 가려져 애니메이션이 멈춰도 구간 반복은 돌도록 타이머도 둔다
  setInterval(function () { if (!player.paused) checkLoop(); }, 100);

  function trackOffset() { return state.track ? (state.track.offset || 0) : 0; }
  function scoreSec() { return player.currentTime - trackOffset(); }

  function play() {
    if (!state.track) { toast('재생할 음원이 없습니다.'); return; }
    // 구간 반복 중인데 구간 밖에 있으면 구간 처음부터
    if (state.loop && !state.recPlay) {
      var s = scoreSec();
      if (s < state.loop.a - 0.05 || s >= state.loop.b) player.currentTime = Math.max(0, state.loop.a + trackOffset());
    }
    if (player === midiPlayer) iosUnmute();
    var p = player.play();
    if (p && p.catch) p.catch(function (e) { toast('재생하지 못했습니다: ' + e.message); });
  }
  function pause() { player.pause(); }
  function setPlayIcon(playing) {
    $('playBtn').textContent = playing ? '❚❚' : '▶';
    $('miniPlay').textContent = playing ? '❚❚' : '▶';
  }
  [audioEl, midiPlayer].forEach(function (pl) {
    pl.addEventListener('play', function () { if (pl !== player) return; setPlayIcon(true); cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
    pl.addEventListener('pause', function () {
      if (pl !== player) return;
      setPlayIcon(false); cancelAnimationFrame(raf); updateHighlight(); updateTimeUi();
      if (state.rec) stopRecording();
      if (state.recPlay) stopRecPlayback();
    });
    pl.addEventListener('ended', function () {
      if (pl !== player) return;
      setPlayIcon(false);
      if (state.rec) stopRecording();
    });
    pl.addEventListener('loadedmetadata', function () { if (pl === player) updateTimeUi(); });
    pl.addEventListener('seeked', function () {
      if (pl !== player) return;
      updateHighlight(); updateTimeUi();
      if (state.recPlay && Math.abs((recEl.currentTime - state.recPlay.rec.lead - state.recLatency) * state.recPlay.rec.rate - (scoreSec() - state.recPlay.rec.scoreStart)) > 0.3) resyncRecording();
    });
  });

  // 아이폰은 무음 스위치가 켜져 있으면 Web Audio(MIDI 소리)가 안 들린다. 무음 소리를 함께 재생하면 들린다.
  var silentEl = null;
  function iosUnmute() {
    if (!isIOS || silentEl) return;
    var sr = 8000, n = sr / 2, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    function w(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    silentEl = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
    silentEl.loop = true;
    silentEl.play().catch(function () { /* 무시 */ });
  }

  // ---------------- 구간 반복 ----------------
  var lastLoopSec = 0;
  function checkLoop() {
    var s = scoreSec();
    // 녹음 중에는 구간 끝에서 되돌아가지 않고 녹음을 마친다. 녹음 다시 듣기 중에는 구간 반복을 쓰지 않는다.
    if (state.rec && state.loop && s >= state.loop.b) { pause(); return; }
    if (state.recPlay) { lastLoopSec = s; return; }
    if (state.loop && s >= state.loop.b && lastLoopSec < state.loop.b && lastLoopSec >= state.loop.a - 0.5) {
      player.currentTime = Math.max(0, state.loop.a + trackOffset());
      lastLoopSec = state.loop.a;
      return;
    }
    lastLoopSec = s;
  }
  function measureNo(mi) { return state.analysis.pickup > 0 ? mi : mi + 1; }
  function updateLoopBtn() {
    var b = $('loopBtn');
    if (!b) return;
    b.classList.toggle('on', !!state.loop || state.loopStep > 0);
    if (state.loop) b.textContent = measureNo(state.loop.ma) + '~' + measureNo(state.loop.mb) + '마디';
    else if (state.loopStep === 1) b.textContent = '시작 마디?';
    else if (state.loopStep === 2) b.textContent = '끝 마디?';
    else b.textContent = '구간반복';
    // 위쪽 안내 띠: 지금 무엇을 골라야 하는지, 무엇을 골랐는지
    var bar = $('loopBanner'), txt = $('loopBannerText');
    if (state.loopStep === 1) txt.textContent = '구간 반복: 시작 마디의 음표를 누르세요';
    else if (state.loopStep === 2) txt.textContent = '시작 ' + measureNo(state.loopStartMeasure) + '마디 ✓ → 끝 마디 음표를 누르세요';
    else if (state.loop) txt.textContent = '반복 중: ' + measureNo(state.loop.ma) + '~' + measureNo(state.loop.mb) + '마디 (빨간 바탕)';
    bar.classList.toggle('hidden', !state.loopStep && !state.loop);
    // 악보 영역 아래쪽(보통 비어 있는 곳)에 띄운다
    if (!bar.classList.contains('hidden')) bar.style.top = (wrap.getBoundingClientRect().bottom - bar.offsetHeight - 8) + 'px';
    $('loopBannerBtn').textContent = state.loop ? '끄기' : '취소';
    drawLoopMarks();
  }
  function clearLoop(msg) {
    state.loop = null; state.loopStep = 0; updateLoopBtn();
    if (msg) toast(msg);
  }
  $('loopBtn').onclick = function () {
    if (state.loop || state.loopStep) { clearLoop('구간 반복을 껐습니다'); return; }
    state.loopStep = 1; updateLoopBtn();
  };
  $('loopBannerBtn').onclick = function () { clearLoop(state.loop ? '구간 반복을 껐습니다' : ''); };

  // 악보 위에 고른 마디를 칠한다(시작 마디 고른 뒤: 그 마디 진하게, 구간이 정해지면: 구간 전체 옅게 + 시작·끝 테두리)
  function drawLoopMarks() {
    var score = $('score');
    Array.prototype.forEach.call(score.querySelectorAll('.loop-mark'), function (n) { n.remove(); });
    if (!state.osmd || !state.osmd.GraphicSheet) return;
    var from, to, kind;
    if (state.loopStep === 2) { from = to = state.loopStartMeasure; kind = 'pick'; }
    else if (state.loop) { from = state.loop.ma; to = state.loop.mb; kind = 'range'; }
    else return;
    var list = state.osmd.GraphicSheet.MeasureList, NS = 'http://www.w3.org/2000/svg';
    var pages = state.osmd.GraphicSheet.MusicPages || [];
    function pageNoOf(sys) { var i = pages.indexOf(sys.Parent); return i >= 0 ? i + 1 : 1; } // 페이지 div id는 1부터
    for (var m = from; m <= to; m++) {
      var bySystem = new Map();
      (list[m] || []).forEach(function (gm) {
        if (!gm || !gm.ParentMusicSystem || !gm.PositionAndShape) return;
        var p = gm.PositionAndShape.AbsolutePosition, sz = gm.PositionAndShape.Size;
        var h = Math.max(sz.height, 4); // 오선 높이 4칸
        var r = bySystem.get(gm.ParentMusicSystem);
        if (!r) bySystem.set(gm.ParentMusicSystem, r = { x: p.x, w: sz.width, top: p.y, bottom: p.y + h, page: pageNoOf(gm.ParentMusicSystem) });
        r.top = Math.min(r.top, p.y); r.bottom = Math.max(r.bottom, p.y + h);
      });
      bySystem.forEach(function (r) {
        // 페이지 SVG 자체의 id가 osmdSvgPageN이다
        var el = score.querySelector('#osmdSvgPage' + r.page);
        var svg = el ? (el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg')) : score.querySelector('svg');
        if (!svg) return;
        var rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('class', 'loop-mark ' + kind + (m === from ? ' first' : '') + (m === to ? ' last' : ''));
        rect.setAttribute('x', r.x * 10);
        rect.setAttribute('y', (r.top - 1.5) * 10);
        rect.setAttribute('width', r.w * 10);
        rect.setAttribute('height', (r.bottom - r.top + 3) * 10);
        svg.insertBefore(rect, svg.firstChild);
      });
    }
  }
  function loopPick(ev) {
    if (state.loopStep === 1) {
      state.loopStartMeasure = ev.measure;
      state.loopStep = 2; updateLoopBtn();
      return;
    }
    var ma = Math.min(state.loopStartMeasure, ev.measure), mb = Math.max(state.loopStartMeasure, ev.measure);
    var a = state.analysis.tickToSec(state.analysis.measures[ma].start);
    var b = state.analysis.tickToSec(state.analysis.measures[mb].end);
    state.loop = { ma: ma, mb: mb, a: a, b: b };
    state.loopStep = 0; updateLoopBtn();
    player.currentTime = Math.max(0, a + trackOffset());
    lastLoopSec = a;
  }

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
    if (idx === undefined) {
      // 음표가 아닌 빈 곳을 누르면 버튼 숨김/보임(구간 고르기·가사 편집 중에는 제외)
      if (!state.loopStep && !state.editLyrics && !state.syncMode) setFocus(!document.body.classList.contains('focus'));
      return;
    }
    if (state.editLyrics) { editNoteLyric(idx); return; }
    if (state.loopStep) { loopPick(state.analysis.events[idx]); return; }
    if (!state.track) return;
    var ev = state.analysis.events[idx];
    var sec = state.analysis.tickToSec(ev.startTick);
    if (state.syncMode && state.track.midi) { state.syncMode = false; $('tapBtn').classList.remove('primary'); toast('MIDI 소리는 맞출 필요가 없습니다'); return; }
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

  // ---------------- 녹음 ----------------
  // 반주를 틀면서 마이크로 녹음하고, 나중에 반주와 겹쳐(또는 내 목소리만) 다시 듣는다.
  // 녹음 정보: { id, blob, mime, createdAt, scoreStart(악보 초), lead(녹음 시작~반주 시작, 초), rate, trackId, trackName, duration }
  var recEl = new Audio();
  recEl.preload = 'auto';
  state.recLatency = 0.15;
  try { var lv = parseFloat(localStorage.getItem('recLatency')); if (isFinite(lv)) state.recLatency = lv; } catch (e) { /* 무시 */ }
  var recTimer = 0;

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    var c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < c.length; i++) if (MediaRecorder.isTypeSupported(c[i])) return c[i];
    return '';
  }
  function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('이 기기·브라우저는 녹음을 지원하지 않습니다', 4000); return;
    }
    if (!state.track) { toast('반주로 쓸 음원이 없습니다'); return; }
    stopRecPlayback();
    pause();
    if (state.loop) player.currentTime = Math.max(0, state.loop.a + trackOffset());
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (stream) {
      var mime = pickMime();
      var rec;
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { rec = new MediaRecorder(stream); }
      var sess = { recorder: rec, stream: stream, chunks: [], mime: rec.mimeType || mime || 'audio/webm', rate: player.playbackRate || 1,
        trackId: state.track.id, trackName: state.track.name, songId: state.song.id };
      rec.ondataavailable = function (e) { if (e.data && e.data.size) sess.chunks.push(e.data); };
      rec.onstop = function () { finishRecording(sess); };
      try { rec.start(250); }
      catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); throw e; }
      state.rec = sess;
      sess.recStart = performance.now();
      sess.scoreStart = scoreSec();
      if (player === midiPlayer) iosUnmute();
      var p = player.play();
      Promise.resolve(p).then(function () {
        sess.lead = (performance.now() - sess.recStart) / 1000;
      }).catch(function (e) { toast('반주를 재생하지 못했습니다: ' + e.message); stopRecording(); });
      $('recBtn').classList.add('on');
      clearInterval(recTimer);
      recTimer = setInterval(function () {
        $('recBtn').textContent = '■ ' + fmt((performance.now() - sess.recStart) / 1000);
      }, 250);
      $('recBtn').textContent = '■ 0:00';
      toast(state.loop ? '녹음 중: 반복 구간 끝에서 자동으로 멈춥니다' : '녹음 중: ■ 또는 일시정지를 누르면 멈춥니다', 3000);
    }).catch(function (e) {
      toast(e && e.name === 'NotAllowedError' ? '마이크 사용을 허용해야 녹음할 수 있습니다' : '마이크를 열지 못했습니다: ' + (e && e.message), 4500);
    });
  }
  function stopRecording() {
    var s = state.rec;
    if (!s) return;
    state.rec = null;
    s.duration = (performance.now() - s.recStart) / 1000;
    if (s.lead === undefined) s.lead = 0;
    clearInterval(recTimer);
    $('recBtn').classList.remove('on');
    $('recBtn').textContent = '🎙 녹음';
    try { if (s.recorder.state !== 'inactive') s.recorder.stop(); } catch (e) { finishRecording(s); }
    s.stream.getTracks().forEach(function (t) { t.stop(); });
    if (!player.paused) pause();
  }
  function finishRecording(s) {
    if (s.done) return;
    s.done = true;
    if (!s.chunks.length || s.duration < 0.8) { toast('녹음이 너무 짧아 저장하지 않았습니다'); return; }
    var blob = new Blob(s.chunks, { type: s.mime.split(';')[0] });
    var item = { id: uid(), blob: blob, mime: s.mime, createdAt: Date.now(), scoreStart: s.scoreStart, lead: s.lead,
      rate: s.rate, trackId: s.trackId, trackName: s.trackName, duration: s.duration };
    if (!state.song || state.song.id !== s.songId) return;
    (state.song.recordings = state.song.recordings || []).unshift(item);
    saveSong().then(function () {
      toast('녹음을 저장했습니다. "내 녹음"에서 들어 보세요', 3000);
      renderRecList();
    });
  }

  function recRangeText(r) {
    var a = state.analysis;
    var m1 = measureAt(a.secToTick(r.scoreStart)), m2 = measureAt(a.secToTick(r.scoreStart + Math.max(0, r.duration - r.lead) * r.rate));
    return measureNo(m1) + '~' + measureNo(m2) + '마디';
  }
  function dateText(t) {
    var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function renderRecList() {
    var ul = $('recList');
    ul.innerHTML = '';
    var list = (state.song && state.song.recordings) || [];
    if (!list.length) { ul.innerHTML = '<li class="empty">아직 녹음이 없습니다. 아래 🎙 녹음을 눌러 반주에 맞춰 불러 보세요.</li>'; return; }
    list.forEach(function (r) {
      var li = document.createElement('li');
      var meta = document.createElement('div'); meta.className = 'meta';
      meta.innerHTML = '<b>' + dateText(r.createdAt) + '</b> · ' + recRangeText(r) + ' · ' + fmt(r.duration) + (r.rate !== 1 ? ' · 속도 ' + r.rate + 'x' : '');
      var acts = document.createElement('div'); acts.className = 'acts';
      function btn(label, fn, on) { var b = document.createElement('button'); b.className = 'small' + (on ? ' on' : ''); b.textContent = label; b.onclick = fn; acts.appendChild(b); return b; }
      var playing = state.recPlay && state.recPlay.rec.id === r.id;
      btn(playing && state.recPlay.mode === 'both' ? '■ 정지' : '▶ 반주와 같이', function () { if (playing && state.recPlay.mode === 'both') stopRecPlayback(); else playRecording(r, 'both'); }, playing && state.recPlay.mode === 'both');
      btn(playing && state.recPlay.mode === 'mine' ? '■ 정지' : '▶ 내 목소리만', function () { if (playing && state.recPlay.mode === 'mine') stopRecPlayback(); else playRecording(r, 'mine'); }, playing && state.recPlay.mode === 'mine');
      btn('보내기', function () {
        var ext = /mp4|aac/.test(r.mime) ? 'm4a' : /ogg/.test(r.mime) ? 'ogg' : 'webm';
        shareBlob(r.blob, safeName(state.song.title) + ' 녹음 ' + dateText(r.createdAt).replace(/[\/: ]/g, '-') + '.' + ext, '내 녹음')
          .catch(function (e) { if (e && e.name !== 'AbortError') toast('보내기 실패: ' + e.message); });
      });
      btn('삭제', function () {
        if (!confirm('이 녹음을 삭제할까요? 되돌릴 수 없습니다.')) return;
        if (state.recPlay && state.recPlay.rec.id === r.id) stopRecPlayback();
        state.song.recordings = state.song.recordings.filter(function (x) { return x.id !== r.id; });
        saveSong().then(renderRecList);
      });
      li.appendChild(meta); li.appendChild(acts);
      ul.appendChild(li);
    });
  }

  function setAccVolume(v) {
    audioEl.volume = Math.max(0, Math.min(1, v));
    midiPlayer.setMasterVolume(v);
  }
  function playRecording(r, mode) {
    stopRecPlayback();
    if (state.rec) return;
    pause();
    // 녹음할 때 쓴 반주로
    var t = r.trackId === MIDI_TRACK_ID ? state.midiTrack : state.song.tracks.filter(function (x) { return x.id === r.trackId; })[0];
    if (t && (!state.track || state.track.id !== t.id)) selectTrack(t.id);
    var url = URL.createObjectURL(r.blob);
    state.recPlay = { rec: r, mode: mode, url: url };
    $('speedSel').value = String(r.rate);
    player.playbackRate = r.rate;
    setAccVolume(mode === 'mine' ? 0 : $('recAccVol').value / 100);
    recEl.volume = $('recMyVol').value / 100;
    recEl.src = url;
    // 녹음 파일과 반주가 둘 다 준비되면 같은 지점에서 함께 시작
    function ready(el, evName, minState) {
      if (!el || el.readyState >= minState) return Promise.resolve();
      return new Promise(function (res) {
        var done = function () { el.removeEventListener(evName, done); res(); };
        el.addEventListener(evName, done);
        setTimeout(done, 4000);
      });
    }
    Promise.all([ready(recEl, 'canplay', 3), player === audioEl ? ready(audioEl, 'loadedmetadata', 1) : null]).then(function () {
      if (!state.recPlay || state.recPlay.url !== url) return;
      player.currentTime = Math.max(0, r.scoreStart + trackOffset());
      try { recEl.currentTime = Math.max(0, r.lead + state.recLatency); } catch (e) { /* 일부 webm은 길이 정보가 없어 처음부터 */ }
      if (player === midiPlayer) iosUnmute();
      return Promise.all([recEl.play(), Promise.resolve(player.play())]);
    }).catch(function (e) { toast('재생하지 못했습니다: ' + e.message); stopRecPlayback(); });
    renderRecList();
  }
  // 녹음 다시 듣는 중 악보를 눌러 이동하면 녹음도 같은 곳으로
  function resyncRecording() {
    var rp = state.recPlay;
    if (!rp) return;
    var t = rp.rec.lead + state.recLatency + (scoreSec() - rp.rec.scoreStart) / rp.rec.rate;
    if (t < 0 || t > rp.rec.duration) { stopRecPlayback(); return; }
    try { recEl.currentTime = t; } catch (e) { /* 무시 */ }
  }
  function stopRecPlayback() {
    var rp = state.recPlay;
    if (!rp) return;
    state.recPlay = null;
    recEl.pause();
    recEl.oncanplay = null;
    URL.revokeObjectURL(rp.url);
    setAccVolume(1);
    if (!player.paused) pause();
    renderRecList();
  }
  recEl.addEventListener('ended', function () { if (state.recPlay) stopRecPlayback(); });

  $('recBtn').onclick = function () { if (state.rec) stopRecording(); else startRecording(); };
  $('recListBtn').onclick = function () { $('latVal').textContent = state.recLatency.toFixed(2); renderRecList(); $('recPanel').classList.remove('hidden'); };
  $('recClose').onclick = function () { $('recPanel').classList.add('hidden'); };
  $('recPanel').onclick = function (e) { if (e.target === this) this.classList.add('hidden'); };
  $('recAccVol').oninput = function () { if (state.recPlay && state.recPlay.mode === 'both') setAccVolume(this.value / 100); };
  $('recMyVol').oninput = function () { recEl.volume = this.value / 100; };
  function setLatency(v) {
    state.recLatency = Math.round(Math.max(-0.5, Math.min(1, v)) * 100) / 100;
    $('latVal').textContent = state.recLatency.toFixed(2);
    try { localStorage.setItem('recLatency', state.recLatency); } catch (e) { /* 무시 */ }
    // 듣는 중이면 바로 반영
    if (state.recPlay) resyncRecording();
  }
  $('latMinus').onclick = function () { setLatency(state.recLatency - 0.03); };
  $('latPlus').onclick = function () { setLatency(state.recLatency + 0.03); };

  // ---------------- 믹서(MIDI 소리 파트별 볼륨·조옮김) ----------------
  function effectiveVolumes() {
    var m = state.song.mix;
    return m.vol.map(function (v, i) { return m.mute[i] ? 0 : v; });
  }
  function applyMix() {
    effectiveVolumes().forEach(function (v, i) { midiPlayer.setVolume(i, v); });
    saveSong();
  }
  function renderMixer() {
    var m = state.song.mix, box = $('mixRows');
    box.innerHTML = '';
    state.analysis.parts.forEach(function (p, i) {
      var row = document.createElement('div'); row.className = 'mix-row';
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
      var sl = document.createElement('input'); sl.type = 'range'; sl.min = 0; sl.max = 100; sl.value = Math.round(m.vol[i] * 100);
      var mu = document.createElement('button'); mu.className = 'mute small' + (m.mute[i] ? ' on' : ''); mu.textContent = m.mute[i] ? '꺼짐' : '켜짐';
      sl.oninput = function () { m.vol[i] = sl.value / 100; if (m.mute[i] && m.vol[i] > 0) { m.mute[i] = false; mu.className = 'mute small'; mu.textContent = '켜짐'; } applyMix(); };
      mu.onclick = function () { m.mute[i] = !m.mute[i]; mu.className = 'mute small' + (m.mute[i] ? ' on' : ''); mu.textContent = m.mute[i] ? '꺼짐' : '켜짐'; applyMix(); };
      row.appendChild(nm); row.appendChild(sl); row.appendChild(mu);
      box.appendChild(row);
    });
    $('trVal').textContent = (m.transpose > 0 ? '+' : '') + m.transpose;
    $('mixHint').textContent = state.track && state.track.midi ? '' : '(지금은 mp3 재생 중: 위쪽 🎹 MIDI 소리를 고르면 적용됩니다)';
  }
  function selectedPartOrWarn() {
    var v = state.song.hlPart;
    if (!v || v === 'all') { toast('위쪽 파트 버튼에서 내 파트를 먼저 고르세요'); return null; }
    return +v;
  }
  function quickMix(kind) {
    var m = state.song.mix, mine = kind === 'even' ? null : selectedPartOrWarn();
    if (kind !== 'even' && mine === null) return;
    m.vol = m.vol.map(function (_, i) {
      if (kind === 'even') return 0.8;
      if (kind === 'mine') return i === mine ? 1 : 0.25;
      return i === mine ? 0 : 0.8;
    });
    m.mute = m.mute.map(function (_, i) { return kind === 'minus' && i === mine; });
    applyMix(); renderMixer();
    if (!(state.track && state.track.midi)) { selectTrack(MIDI_TRACK_ID); toast('MIDI 소리로 바꿨습니다'); }
  }
  $('mixBtn').onclick = function () { renderMixer(); $('mixPanel').classList.remove('hidden'); };
  $('mixClose').onclick = function () { $('mixPanel').classList.add('hidden'); };
  $('mixPanel').onclick = function (e) { if (e.target === this) this.classList.add('hidden'); };
  $('mixMine').onclick = function () { quickMix('mine'); };
  $('mixMinus').onclick = function () { quickMix('minus'); };
  $('mixEven').onclick = function () { quickMix('even'); };
  function setTranspose(d) {
    var m = state.song.mix;
    m.transpose = Math.max(-12, Math.min(12, m.transpose + d));
    midiPlayer.setTranspose(m.transpose);
    saveSong(); renderMixer();
  }
  $('trDown').onclick = function () { setTranspose(-1); };
  $('trUp').onclick = function () { setTranspose(1); };

  // ---------------- 곡 묶음 내보내기·가져오기 ----------------
  function audioExt(t) {
    var m = /\.([a-z0-9]{2,4})$/i.exec((t.blob && t.blob.name) || '');
    if (m) return m[1].toLowerCase();
    var ty = (t.blob && t.blob.type) || '';
    return /mpeg|mp3/.test(ty) ? 'mp3' : /mp4|m4a|aac/.test(ty) ? 'm4a' : /wav/.test(ty) ? 'wav' : /ogg/.test(ty) ? 'ogg' : 'mp3';
  }
  function safeName(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80); }

  function exportPack() {
    var s = state.song;
    toast('곡 묶음을 만드는 중…', 5000);
    return buildPack().then(function (blob) {
      return shareBlob(blob, safeName(s.title) + ' (악보하이라이트).zip', s.title);
    }).catch(function (e) { if (e && e.name !== 'AbortError') toast('내보내기 실패: ' + e.message, 4000); });
  }
  function buildPack() {
    var s = state.song;
    var files = [];
    var meta = {
      format: 'score-highlight-pack', version: 1, title: s.title, midiName: s.midiName,
      hlPart: s.hlPart, lyrics: s.lyrics || null, mix: s.mix || null, tracks: []
    };
    var jobs = s.tracks.map(function (t, i) {
      var fname = 'audio/' + (i + 1) + '_' + safeName(t.name) + '.' + audioExt(t);
      meta.tracks.push({ name: t.name, file: fname, part: t.part, offset: t.offset });
      return readBuffer(t.blob).then(function (b) { files.push({ name: fname, data: new Uint8Array(b) }); });
    });
    return Promise.all(jobs).then(function () {
      files.unshift({ name: 'song.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 1)) },
        { name: safeName(s.midiName || 'score.mid'), data: new Uint8Array(s.midi) });
      meta.midiFile = files[1].name;
      files[0].data = new TextEncoder().encode(JSON.stringify(meta, null, 1));
      return SongPack.writeZip(files);
    });
  }

  function shareBlob(blob, fileName, title) {
    var Cap = window.Capacitor, Pl = Cap && Cap.Plugins;
    // 안드로이드 앱: 캐시 폴더에 저장한 뒤 공유 창(카카오톡 등)
    if (isNative && Pl && Pl.Filesystem && Pl.Share) {
      return readBuffer(blob).then(function (buf) {
        return Pl.Filesystem.writeFile({ path: fileName, data: SongPack.toBase64(new Uint8Array(buf)), directory: 'CACHE' });
      }).then(function (r) {
        return Pl.Share.share({ title: title, text: '악보 하이라이트 곡 묶음: ' + title, files: [r.uri], dialogTitle: '곡 묶음 보내기' });
      });
    }
    // 아이폰·안드로이드 브라우저: 공유 시트
    var file;
    try { file = new File([blob], fileName, { type: 'application/zip' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: title });
    }
    // PC 등: 파일로 내려받기
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    toast('곡 묶음을 저장했습니다: ' + fileName, 3500);
    return Promise.resolve();
  }

  function importPack(file) {
    toast('곡 묶음을 여는 중…', 5000);
    readBuffer(file).then(function (buf) {
      var entries = SongPack.readZip(buf);
      if (!entries['song.json']) throw new Error('악보 하이라이트 곡 묶음이 아닙니다(song.json 없음)');
      var meta = JSON.parse(new TextDecoder('utf-8').decode(entries['song.json']));
      var midiBytes = entries[meta.midiFile];
      if (!midiBytes) throw new Error('묶음에 MIDI가 없습니다');
      var midiBuf = midiBytes.buffer.slice(midiBytes.byteOffset, midiBytes.byteOffset + midiBytes.byteLength);
      Midi2Xml.analyze(midiBuf); // 읽히는지 확인
      var song = {
        id: uid(), title: meta.title || baseName(file.name), midiName: meta.midiName || meta.midiFile, midi: midiBuf,
        hlPart: meta.hlPart || 'all', lyrics: meta.lyrics || undefined, mix: meta.mix || undefined,
        tracks: (meta.tracks || []).filter(function (t) { return entries[t.file]; }).map(function (t) {
          var ext = (/\.([a-z0-9]+)$/i.exec(t.file) || [, 'mp3'])[1].toLowerCase();
          var type = ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'application/octet-stream';
          return { id: uid(), name: t.name, blob: new Blob([entries[t.file]], { type: type }), part: t.part || 'all', offset: t.offset === undefined ? null : t.offset };
        }),
        createdAt: Date.now()
      };
      return SongStore.put(song).then(function () { toast('"' + song.title + '" 곡을 가져왔습니다'); openSong(song.id); });
    }).catch(function (e) { toast('곡 묶음을 열지 못했습니다: ' + e.message, 5000); });
  }
  $('exportBtn').onclick = function () { $('panel').classList.add('hidden'); exportPack(); };

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
  // 확대는 5% 단위(기본 45%로 돌아갈 수 있게)
  function setZoom(z) {
    state.zoom = Math.max(0.2, Math.min(2, Math.round(z * 20) / 20));
    try { localStorage.setItem('zoom', state.zoom); } catch (e) { /* 무시 */ }
    renderScore(false, true).then(updateHighlight);
  }
  $('zoomIn').onclick = function () { setZoom(state.zoom + 0.05); };
  $('zoomOut').onclick = function () { setZoom(state.zoom - 0.05); };
  function setOffset(v) {
    if (!state.track) return;
    if (state.track.midi) { toast('MIDI 소리는 시작 위치를 맞출 필요가 없습니다'); $('offsetInput').value = '0.00'; return; }
    state.track.offset = Math.round(v * 100) / 100;
    $('offsetInput').value = state.track.offset.toFixed(2);
    saveSong(); updateHighlight();
  }
  $('offMinus').onclick = function () { setOffset((state.track ? state.track.offset || 0 : 0) - 0.05); };
  $('offPlus').onclick = function () { setOffset((state.track ? state.track.offset || 0 : 0) + 0.05); };
  $('offsetInput').onchange = function () { var v = parseFloat(this.value); if (isFinite(v)) setOffset(v); };
  $('autoSyncBtn').onclick = function () { if (state.track && state.track.midi) { toast('MIDI 소리는 맞출 필요가 없습니다'); return; } if (state.track) { toast('음원을 분석하는 중…'); autoSync(state.track, true); } };
  $('deleteSongBtn').onclick = function () {
    if (!confirm('"' + state.song.title + '" 곡을 삭제할까요? 폰에 저장한 MIDI와 음원이 지워집니다.')) return;
    SongStore.remove(state.song.id).then(function () { $('panel').classList.add('hidden'); state.song = null; showList(); });
  };
  $('backBtn').onclick = showList;

  // 악보 영역 크기가 바뀌면(화면 회전, 버튼 숨김/보임, 늦게 적용된 글꼴로 버튼 줄 수가 바뀜, 주소창 접힘 등)
  // 페이지를 화면에 맞게 다시 나눈다. 그리지 않으면 페이지가 화면보다 커져 맨 아래 줄(베이스)이 잘린다.
  var rt = 0;
  function sizeChanged() {
    if (!state.song || !state.osmd || $('songView').classList.contains('hidden')) return false;
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return false;
    if (state.layout === 'page') return Math.abs(w - state.pageW) > 2 || Math.abs(h - state.pageH) > 2;
    return Math.abs(w - (state.lastRenderW || 0)) > 30;
  }
  function onWrapResize() {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (sizeChanged()) renderScore(false, true).then(function () { updateHighlight(); });
    }, 250);
  }
  if (window.ResizeObserver) new ResizeObserver(onWrapResize).observe(wrap);
  window.addEventListener('resize', onWrapResize);
  // 글꼴이 늦게 적용돼 버튼 줄 높이가 바뀌는 경우, 앱으로 돌아온 경우에도 확인
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(onWrapResize);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) onWrapResize(); });

  // ---------------- 악보 크게 보기(버튼 숨김) ----------------
  function setFocus(on) {
    document.body.classList.toggle('focus', on);
    try { localStorage.setItem('focus', on ? '1' : ''); } catch (e) { /* 무시 */ }
    if (state.loop || state.loopStep) updateLoopBtn();
    onWrapResize(); // 악보 영역이 커지거나 작아졌으니 페이지를 다시 나눈다
  }
  $('focusBtn').onclick = function () { setFocus(true); };
  $('miniShow').onclick = function () { setFocus(false); };
  $('miniPlay').onclick = function () { $('playBtn').click(); };
  $('miniBack').onclick = function () { $('back5').click(); };
  try { if (localStorage.getItem('focus')) document.body.classList.add('focus'); } catch (e) { /* 무시 */ }

  // 아이폰: 파일 선택 창에서 .mid가 흐리게 막히지 않도록 형식 제한을 푼다
  var isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) { $('filePick').removeAttribute('accept'); }

  // 웹앱(아이폰 홈 화면 등): 오프라인 캐시 등록, 저장한 곡이 지워지지 않게 요청
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isNative && 'serviceWorker' in navigator && location.protocol === 'https:') {
    // 새 버전이 설치되면(이미 쓰던 사람만) 화면을 한 번 새로 고쳐 바로 새 버전으로 바꾼다
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) return;
      if (state.rec || (!player.paused)) return; // 녹음·재생 중에는 방해하지 않는다(다음에 열 때 적용)
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      // 앱으로 돌아올 때마다 새 버전 확인
      document.addEventListener('visibilitychange', function () { if (!document.hidden) reg.update().catch(function () { /* 무시 */ }); });
    }).catch(function (e) { console.warn('서비스 워커 등록 실패', e); });
  }
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () { /* 무시 */ }); }

  // ---------------- 안드로이드 앱 라이브 업데이트 ----------------
  // 앱을 열 때 웹 주소(GitHub Pages)에 새 버전이 있으면 파일을 받아 폰 안(앱 전용 폴더)에 저장하고
  // 그 폴더로 앱 화면을 바꿔 연다. 주소(https://localhost)는 그대로라 저장한 곡·녹음이 유지된다.
  // 새 APK를 설치하면 Capacitor가 APK 안의 파일로 되돌린다(빌드마다 versionCode를 올림).
  var LIVE_BASE = 'https://connectedheart.github.io/score-highlight/';
  var liveBusy = false;
  function liveUpdate(manual) {
    var Pl = window.Capacitor && window.Capacitor.Plugins;
    if (!isNative || liveBusy || !Pl || !Pl.Filesystem || !Pl.WebView) { if (manual) toast('이 기기에서는 쓰지 않습니다'); return; }
    if (!player.paused || state.rec) return; // 재생·녹음 중에는 다음 기회에
    liveBusy = true;
    var local = null;
    fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      .then(function (l) {
        local = l;
        return fetch(LIVE_BASE + 'version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('버전 정보 HTTP ' + r.status);
          return r.json();
        });
      })
      .then(function (remote) {
        if (!remote || !remote.version || !remote.files || !remote.files.length) return;
        if (local && local.version && remote.version <= local.version) { if (manual) toast('최신 버전입니다 (' + local.version + ')'); return; }
        toast('새 버전을 받는 중…', 6000);
        var dir = 'live/' + remote.version;
        var chain = Promise.resolve();
        remote.files.forEach(function (f) {
          chain = chain.then(function () {
            return fetch(LIVE_BASE + f + '?v=' + remote.version, { cache: 'no-store' }).then(function (r) {
              if (!r.ok) throw new Error(f + ' HTTP ' + r.status);
              return r.arrayBuffer();
            }).then(function (buf) {
              return Pl.Filesystem.writeFile({ path: dir + '/' + f, data: SongPack.toBase64(new Uint8Array(buf)), directory: 'DATA', recursive: true });
            });
          });
        });
        return chain.then(function () {
          return Pl.Filesystem.getUri({ path: dir, directory: 'DATA' });
        }).then(function (u) {
          if (!player.paused || state.rec) { liveBusy = false; return; } // 그 사이 재생을 시작했으면 다음에
          var p = decodeURIComponent(u.uri.replace(/^file:\/\//, ''));
          try { localStorage.setItem('livePending', remote.version); } catch (e) { /* 무시 */ }
          toast('새 버전으로 바꿉니다', 2000);
          return Pl.WebView.setServerBasePath({ path: p }); // 화면이 새 버전으로 다시 열린다
        });
      })
      .catch(function (e) { console.warn('라이브 업데이트 실패', e); if (manual) toast('업데이트 확인 실패: ' + e.message, 4000); })
      .then(function () { liveBusy = false; });
  }
  // 새 버전으로 막 바뀌어 열렸으면 그 위치를 기억시켜 다음 실행에도 새 버전으로 연다
  function liveConfirm() {
    var Pl = window.Capacitor && window.Capacitor.Plugins;
    var pending = null;
    try { pending = localStorage.getItem('livePending'); } catch (e) { /* 무시 */ }
    if (!isNative || !pending || !Pl || !Pl.WebView) return Promise.resolve();
    return fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
      if (v && v.version === pending) {
        return Pl.WebView.persistServerBasePath().then(function () {
          try { localStorage.removeItem('livePending'); } catch (e) { /* 무시 */ }
          toast('새 버전으로 업데이트했습니다 (' + v.version + ')', 3000);
        });
      }
    }).catch(function () { /* 무시 */ });
  }
  fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (v) { $('appVer').textContent = v.version; }).catch(function () { $('appVer').textContent = '(개발용)'; });
  $('updateBtn').onclick = function () {
    if (isNative) { toast('업데이트 확인 중…'); liveUpdate(true); }
    else { toast('새로 고칩니다'); setTimeout(function () { location.reload(); }, 500); }
  };
  if (isNative) {
    liveConfirm().then(function () { setTimeout(liveUpdate, 1500); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) liveUpdate(); });
  }

  // 안드로이드 뒤로 가기 버튼
  var Cap = window.Capacitor;
  if (Cap && Cap.Plugins && Cap.Plugins.App) {
    Cap.Plugins.App.addListener('backButton', function () {
      if (!$('panel').classList.contains('hidden')) $('panel').classList.add('hidden');
      else if (!$('songView').classList.contains('hidden')) showList();
      else Cap.Plugins.App.exitApp();
    });
  }

  // ---------------- 튜토리얼 ----------------
  var SAMPLE_ID = 'sample-twinkle';
  function ensureSample() {
    return SongStore.get(SAMPLE_ID).then(function (s) {
      if (s) return s;
      var song = { id: SAMPLE_ID, title: '예제: 반짝반짝 작은 별', midiName: 'twinkle-sample.mid', midi: Tutorial.makeSampleMidi(),
        tracks: [], hlPart: '0', createdAt: Date.now() };
      return SongStore.put(song).then(function () { return song; });
    });
  }
  function closeAllPanels() {
    ['panel', 'mixPanel', 'lyricDialog'].forEach(function (id) { $(id).classList.add('hidden'); });
    if (state.editLyrics) setEditLyrics(false);
  }
  function inSong() { return !$('songView').classList.contains('hidden'); }
  function openSample() {
    closeAllPanels();
    if (inSong() && state.song && state.song.id === SAMPLE_ID) return Promise.resolve();
    pause();
    return ensureSample().then(function () { return openSong(SAMPLE_ID); }).then(function () {
      return new Promise(function (r) { setTimeout(r, 300); });
    });
  }
  function tutorialSteps() {
    return [
      { title: '악보 하이라이트에 오신 걸 환영합니다', text: 'MIDI 악보와 연습 음원을 같이 재생하면, 내가 고른 파트의 <b>지금 부를 음표가 빨갛게</b> 표시됩니다.<br>예제 곡으로 하나씩 따라 해 볼게요. 언제든 <b>건너뛰기</b>를 눌러 끝낼 수 있습니다.',
        before: function () { closeAllPanels(); if (inSong()) showList(); } },
      { target: '#addSongBtn', title: '곡 추가', text: '여기서 <b>MIDI 파일 1개</b>와 <b>연습 음원(mp3)</b>을 한 번에 골라 곡을 추가합니다. 다른 사람이 보낸 <b>곡 묶음(.zip)</b>도 여기서 고르면 그대로 들어옵니다.<br>MIDI와 mp3는 카카오톡 "파일에 저장"이나 클라우드로 폰에 넣어 두세요.',
        before: function () { closeAllPanels(); if (inSong()) showList(); } },
      { title: '예제 곡을 열어 볼게요', text: '"반짝반짝 작은 별"을 4성부(소프라노·알토·테너·베이스)로 만든 예제 곡입니다. 다음을 누르면 열립니다.', nextLabel: '예제 곡 열기' },
      { v: 4, target: '#partBar', title: '내 파트 고르기', text: '빨갛게 표시할 파트를 고릅니다. 파트 버튼은 한 줄로 있어서 <b>손가락으로 좌우로 끌면</b> 다른 파트가 보입니다. <b>전체</b>를 고르면 모든 파트가 표시됩니다. 악보는 항상 전체가 보이고, 고른 파트만 빨갛게 바뀝니다.',
        before: openSample, wait: 200 },
      { target: '#trackBar', title: '들을 소리 고르기', text: '곡에 넣은 mp3 음원(♪)과 <b>🎹 MIDI 소리</b> 중에서 고릅니다. mp3가 없어도 MIDI 소리로 들을 수 있습니다. 예제 곡은 MIDI 소리만 있습니다.',
        before: openSample },
      { target: '#playBtn', title: '재생', text: '누르면 재생됩니다. 빨간 음표가 다음 페이지로 넘어가면 화면이 <b>바로</b> 다음 페이지로 바뀝니다. 오른쪽 아래 숫자가 페이지 번호입니다.',
        before: openSample },
      { target: '#scoreWrap', title: '악보 다루기', text: '<b>음표를 누르면</b> 그 위치로 이동합니다. <b>빈 곳을 누르면</b> 버튼이 숨고 악보가 크게 보입니다(다시 누르면 나옴).<br>화면을 <b>좌우로 밀면</b> 페이지를 넘겨 볼 수 있고, 4초 뒤 다시 재생 위치를 따라갑니다.',
        before: openSample },
      { target: '#loopBtn', title: '구간 반복', text: '어려운 부분만 반복합니다. 누른 뒤 <b>시작 마디의 음표</b> → <b>끝 마디의 음표</b>를 차례로 누르면, 그 구간이 빨간 바탕으로 칠해지고 계속 반복됩니다. 다시 누르면 꺼집니다.',
        before: openSample },
      { target: '#mixBtn', title: '믹서', text: 'MIDI 소리일 때 파트별 볼륨을 조절합니다. <b>내 파트 크게</b>, <b>내 파트 빼고</b>(나머지 파트만 반주처럼), 조옮김을 할 수 있습니다.',
        before: openSample },
      { target: '#speedSel', title: '속도', text: '0.5배~1.1배로 느리게·빠르게 들을 수 있습니다. 음 높이는 그대로입니다.',
        before: openSample },
      { v: 2, target: '#recBtn', title: '반주 틀고 녹음', text: '누르면 지금 위치부터 반주를 틀면서 <b>내 목소리를 녹음</b>합니다(처음 한 번 마이크 허용). 다시 누르거나 일시정지하면 저장됩니다. 구간 반복이 켜져 있으면 그 구간만 녹음합니다.<br><b>이어폰</b>을 끼면 반주가 녹음에 섞이지 않습니다.',
        before: openSample },
      { v: 2, target: '#recListBtn', title: '내 녹음 듣기', text: '녹음 목록입니다. <b>반주와 같이</b> 또는 <b>내 목소리만</b> 들을 수 있고, 악보 빨간 표시도 따라갑니다. 목소리가 반주보다 늦게 들리면 <b>녹음 박자 보정</b>으로 맞추세요. 카카오톡 등으로 보낼 수도 있습니다.',
        before: openSample },
      { v: 3, target: '#focusBtn', title: '악보 크게 보기', text: '<b>악보의 빈 곳(음표가 아닌 곳)을 누르면</b> 위·아래 버튼이 숨고 악보가 화면 가득 보입니다. 한 번 더 누르면 버튼이 다시 나옵니다. 이 버튼으로도 숨길 수 있습니다.<br>숨긴 동안에는 오른쪽 아래 작은 조작부(▶, ↺5)로 재생합니다. 화면이 작아 악보 한 단이 다 안 들어가면 크기를 자동으로 줄여 아래 줄이 잘리지 않게 합니다.',
        before: openSample },
      { target: '#menuBtn', title: '설정', text: '확대·축소, 가사 표시, <b>가사 고치기</b>, 음원 추가, <b>곡 묶음 내보내기</b>(단원에게 공유), 사용법 다시 보기가 여기 있습니다.',
        before: openSample },
      { target: '#backBtn', title: '다 됐습니다', text: '이제 내 곡을 추가해 연습해 보세요. 왼쪽 위 화살표로 곡 목록에 돌아갑니다. 예제 곡은 목록에 남아 있으니 지워도 되고, 사용법은 목록 화면의 <b>?</b> 버튼으로 다시 볼 수 있습니다.',
        before: openSample }
    ];
  }
  // 튜토리얼 판(版). 기능을 추가하면 그 단계에 v: 새 번호를 붙이고 이 값을 올린다.
  // 이전 판을 본 사람에게는 앱을 열 때 새 단계만 "새로 추가된 기능"으로 보여 준다.
  //  1: 기본(곡 추가~설정)  2: 녹음, 내 녹음  3: 악보 빈 곳 눌러 버튼 숨기기(악보 크게 보기), 화면에 맞춤
  //  4: 파트 버튼 한 줄 가로 스크롤
  var TUTORIAL_VERSION = 4;
  function seenTutorialVersion() {
    try {
      var v = parseInt(localStorage.getItem('tutorialVersion'), 10);
      if (isFinite(v)) return v;
      return localStorage.getItem('tutorialDone') ? 1 : 0;
    } catch (e) { return TUTORIAL_VERSION; }
  }
  function markTutorialSeen() {
    try { localStorage.setItem('tutorialVersion', String(TUTORIAL_VERSION)); localStorage.setItem('tutorialDone', '1'); } catch (e) { /* 무시 */ }
  }
  function startTutorial() {
    markTutorialSeen();
    setFocus(false); // 튜토리얼은 버튼을 짚어야 하므로 버튼을 보인다
    Tutorial.start(tutorialSteps(), function () { pause(); });
  }
  function startWhatsNew(since) {
    var fresh = tutorialSteps().filter(function (s) { return (s.v || 1) > since; });
    markTutorialSeen();
    if (!fresh.length) return;
    setFocus(false);
    var steps = [{ title: '새로 추가된 기능이 있어요', text: '앱이 업데이트됐습니다. 새 기능 ' + fresh.length + '가지를 예제 곡 화면에서 짧게 보여 드릴게요.',
      before: function () { closeAllPanels(); }, nextLabel: '보기' }]
      .concat(fresh)
      .concat([{ target: '#backBtn', title: '끝', text: '전체 사용법은 목록 화면의 <b>?</b> 버튼이나 ⋯ 설정의 "사용법 다시 보기"에서 언제든 볼 수 있습니다.', before: openSample }]);
    Tutorial.start(steps, function () { pause(); });
  }
  $('helpBtn').onclick = startTutorial;
  $('sampleBtn').onclick = startTutorial;
  $('tutorialBtn').onclick = function () { $('panel').classList.add('hidden'); startTutorial(); };
  function maybeFirstRunTutorial() {
    var seen = seenTutorialVersion();
    if (seen <= 0) setTimeout(startTutorial, 600);
    else if (seen < TUTORIAL_VERSION) setTimeout(function () { startWhatsNew(seen); }, 600);
  }

  // 시험용: ?demo=1 이면 sample/ 폴더의 score.mid와 음원을 불러온다(PC 확인용)
  window.__app = { state: state, openSong: openSong, selectTrack: selectTrack, updateHighlight: updateHighlight,
    buildPack: buildPack, importPack: importPack, midiPlayer: midiPlayer, getPlayer: function () { return player; },
    startTutorial: startTutorial };
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
    maybeFirstRunTutorial();
  }
})();
