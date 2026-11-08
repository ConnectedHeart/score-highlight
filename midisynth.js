/*
 * MIDI 소리 재생기. <audio>와 같은 모양(currentTime, paused, play, pause, playbackRate, duration, 이벤트)으로 만들어
 * 앱이 mp3와 똑같이 다룬다. 파트별 볼륨, 조옮김을 지원한다. 소리는 Web Audio로 합성한다(오-소리 비슷한 부드러운 음색).
 */
(function (root) {
  'use strict';

  var LOOKAHEAD = 0.3;   // 몇 초(악보 시간) 앞까지 미리 예약할지
  var TICK_MS = 30;

  function MidiPlayer() {
    this._ls = {};
    this.paused = true;
    this.duration = 0;
    this._pos = 0;          // 멈췄을 때 위치(악보 초)
    this._rate = 1;
    this._ctx = null;
    this._startCtx = 0;     // 재생 시작 시점의 ctx 시각
    this._notes = [];
    this._idx = 0;
    this._voices = [];
    this._timer = 0;
    this.transpose = 0;
    this.volumes = [];
    this._gains = [];
    this._master = null;
    this.preservesPitch = true;
  }
  var P = MidiPlayer.prototype;

  P.addEventListener = function (t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); };
  P.removeEventListener = function (t, fn) { var a = this._ls[t] || []; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  P._emit = function (t) { var self = this; (this._ls[t] || []).slice().forEach(function (fn) { try { fn.call(self, { type: t }); } catch (e) { console.error(e); } }); };

  // analysis: Midi2Xml.analyze 결과(parts[i].notes = [{start,end,key}] tick)
  P.load = function (analysis, volumes, transpose) {
    this.pause();
    var notes = [];
    analysis.parts.forEach(function (p, pi) {
      (p.notes || []).forEach(function (n) {
        notes.push({ t0: analysis.tickToSec(n.start), t1: analysis.tickToSec(n.end), key: n.key, part: pi });
      });
    });
    notes.sort(function (a, b) { return a.t0 - b.t0; });
    this._notes = notes;
    this.duration = analysis.tickToSec(analysis.endTick) + 1;
    this.volumes = (volumes && volumes.length === analysis.parts.length) ? volumes.slice() : analysis.parts.map(function () { return 0.8; });
    this.transpose = transpose || 0;
    this._pos = 0;
    this._gains = [];
    var self = this;
    setTimeout(function () { self._emit('loadedmetadata'); }, 0);
  };

  P._ensureCtx = function () {
    if (this._ctx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx();
    this._master = this._ctx.createGain();
    this._master.gain.value = 0.5 * (this._masterVol === undefined ? 1 : this._masterVol);
    var comp = this._ctx.createDynamicsCompressor();
    this._master.connect(comp);
    comp.connect(this._ctx.destination);
  };
  P._gainFor = function (part) {
    var g = this._gains[part];
    if (!g) {
      g = this._gains[part] = this._ctx.createGain();
      g.gain.value = this.volumes[part] === undefined ? 0.8 : this.volumes[part];
      g.connect(this._master);
    }
    return g;
  };
  // 전체 볼륨(녹음 다시 듣기에서 반주 크기 조절용), 1 = 기본
  P.setMasterVolume = function (v) {
    this._masterVol = v;
    if (this._master && this._ctx) this._master.gain.setTargetAtTime(0.5 * v, this._ctx.currentTime, 0.02);
  };
  P.setVolume = function (part, v) {
    this.volumes[part] = v;
    if (this._gains[part] && this._ctx) this._gains[part].gain.setTargetAtTime(v, this._ctx.currentTime, 0.02);
  };
  // 기준음(A4 Hz)
  P.setTuning = function (hz) {
    this.tuning = hz;
    if (!this.paused) { var t = this.currentTime; this._stopVoices(); this._seekInternal(t); }
  };
  P.setTranspose = function (semi) {
    this.transpose = semi;
    if (!this.paused) { var t = this.currentTime; this._stopVoices(); this._seekInternal(t); }
  };

  Object.defineProperty(P, 'currentTime', {
    get: function () {
      if (this.paused || !this._ctx) return this._pos;
      return Math.max(0, this._pos + (this._ctx.currentTime - this._startCtx) * this._rate);
    },
    set: function (v) {
      v = Math.max(0, Math.min(this.duration, +v || 0));
      if (this.paused) { this._pos = v; }
      else { this._stopVoices(); this._seekInternal(v); }
      var self = this;
      setTimeout(function () { self._emit('seeked'); }, 0);
    }
  });
  Object.defineProperty(P, 'playbackRate', {
    get: function () { return this._rate; },
    set: function (v) {
      v = +v || 1;
      if (!this.paused && this._ctx) { var t = this.currentTime; this._rate = v; this._stopVoices(); this._seekInternal(t); }
      else this._rate = v;
    }
  });

  P._seekInternal = function (t) {
    this._pos = t;
    this._startCtx = this._ctx.currentTime + 0.03;
    var lo = 0, hi = this._notes.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (this._notes[m].t0 < t) lo = m + 1; else hi = m; }
    this._idx = lo;
    // 이미 울리고 있어야 할 음(시작은 지났고 끝은 안 지남)도 이어서 낸다
    for (var i = lo - 1; i >= 0 && i >= lo - 40; i--) {
      var n = this._notes[i];
      if (n.t1 > t + 0.05) this._voice(n, this._startCtx, this._startCtx + (n.t1 - t) / this._rate);
    }
    this._schedule();
  };

  P.play = function () {
    if (!this.paused) return Promise.resolve();
    this._ensureCtx();
    var self = this;
    var r = this._ctx.state === 'suspended' ? this._ctx.resume() : Promise.resolve();
    if (this._pos >= this.duration - 0.05) this._pos = 0;
    this.paused = false;
    this._seekInternal(this._pos);
    clearInterval(this._timer);
    this._timer = setInterval(function () { self._schedule(); }, TICK_MS);
    this._emit('play');
    return r;
  };
  P.pause = function () {
    if (this.paused) return;
    this._pos = this.currentTime;
    this.paused = true;
    clearInterval(this._timer);
    this._stopVoices();
    this._emit('pause');
  };

  P._schedule = function () {
    if (this.paused) return;
    var now = this.currentTime;
    if (now >= this.duration) {
      this.pause(); this._pos = this.duration; this._emit('ended'); return;
    }
    var horizon = now + LOOKAHEAD * this._rate;
    while (this._idx < this._notes.length && this._notes[this._idx].t0 < horizon) {
      var n = this._notes[this._idx++];
      var when = this._startCtx + (n.t0 - this._pos) / this._rate;
      var end = this._startCtx + (n.t1 - this._pos) / this._rate;
      if (end > this._ctx.currentTime) this._voice(n, Math.max(when, this._ctx.currentTime), end);
    }
    // 끝난 음 정리
    var t = this._ctx.currentTime;
    this._voices = this._voices.filter(function (v) { return v.end + 0.3 > t; });
  };

  P._voice = function (n, when, end) {
    var ctx = this._ctx;
    var vol = this.volumes[n.part];
    if (vol !== undefined && vol <= 0.001) return;
    var f = (this.tuning || 440) * Math.pow(2, (n.key + this.transpose - 69) / 12);
    var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = 'triangle'; o1.frequency.value = f;
    o2.type = 'sine'; o2.frequency.value = f * 2;
    var g2 = ctx.createGain(); g2.gain.value = 0.25;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(4000, f * 6); lp.Q.value = 0.5;
    var env = ctx.createGain();
    var atk = 0.04, rel = 0.12, peak = 0.35;
    var holdEnd = Math.max(when + atk, end - 0.02);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + atk);
    env.gain.setValueAtTime(peak * 0.85, holdEnd);
    env.gain.linearRampToValueAtTime(0, holdEnd + rel);
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(env); env.connect(this._gainFor(n.part));
    o1.start(when); o2.start(when);
    o1.stop(holdEnd + rel + 0.02); o2.stop(holdEnd + rel + 0.02);
    this._voices.push({ o1: o1, o2: o2, env: env, end: holdEnd + rel });
  };

  P._stopVoices = function () {
    if (!this._ctx) return;
    var t = this._ctx.currentTime;
    this._voices.forEach(function (v) {
      try {
        v.env.gain.cancelScheduledValues(t);
        v.env.gain.setValueAtTime(v.env.gain.value, t);
        v.env.gain.linearRampToValueAtTime(0, t + 0.03);
        v.o1.stop(t + 0.05); v.o2.stop(t + 0.05);
      } catch (e) { /* 이미 멈춤 */ }
    });
    this._voices = [];
  };

  root.MidiPlayer = MidiPlayer;
})(typeof self !== 'undefined' ? self : this);
