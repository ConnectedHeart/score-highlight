// 악보를 빨리 그리기 위한 OSMD 보정.
// OSMD는 줄 사이 간격을 정하려고 마디마다 숨은 캔버스에 악보를 한 번 더 그린 뒤 픽셀을 읽는다(전체 그리기 시간의 약 70%).
// 여기서는 그리지 않고 음표(머리·기둥)의 위치 상자로 오선 위아래로 튀어나온 높이를 계산한다. 결과가 이상하면 원래 방식으로 돌아간다.
(function () {
  var ns = window.opensheetmusicdisplay;
  if (!ns || !ns.VexFlowMusicSheetCalculator) return;
  var P = ns.VexFlowMusicSheetCalculator.prototype;
  var original = P.calculateSkyBottomLines;
  if (!original || P.__fastSky) return;

  function measureLines(m, samplingUnit) {
    var st = m.getVFStave();
    var r = Math.floor(st.getWidth());
    if (!(r > 0)) r = 50;
    var d = Math.max(Math.ceil(m.PositionAndShape.Size.width * samplingUnit), 1);
    var n = Math.max(d, r);
    // 원래 방식과 같이 마디를 0 위치에 두고 음표 위치를 다시 잡는다(실제 그릴 때 제자리로 돌아간다)
    st.setX(0);
    m.format();
    var top = st.getYForLine(0), bot = st.getYForLine(4);
    var sky = new Array(n), bottom = new Array(n);
    for (var i = 0; i < n; i++) { sky[i] = top; bottom[i] = bot; }
    function upd(x0, x1, y0, y1) {
      if (!isFinite(x0) || !isFinite(x1) || !isFinite(y0) || !isFinite(y1)) return;
      var a = Math.max(0, Math.floor(x0)), b = Math.min(n - 1, Math.ceil(x1));
      for (var x = a; x <= b; x++) { if (y0 < sky[x]) sky[x] = y0; if (y1 > bottom[x]) bottom[x] = y1; }
    }
    // 줄 맨 앞의 음자리표·조표·박자표(음자리표가 오선 위아래로 조금 나온다)
    var startX = st.getNoteStartX();
    if (startX > 5) upd(0, startX, top - 15, bot + 15);
    // 빔이 있으면 기둥 길이를 빔에 맞춘다
    var beams = m.vfbeams ? Object.keys(m.vfbeams) : [];
    beams.forEach(function (k) {
      (m.vfbeams[k] || []).forEach(function (b) { try { if (b.postFormat) b.postFormat(); } catch (e) { /* 무시 */ } });
    });
    var voices = m.vfVoices ? Object.keys(m.vfVoices) : [];
    voices.forEach(function (k) {
      var v = m.vfVoices[k];
      if (!v || !v.getTickables) return;
      v.getTickables().forEach(function (t) {
        var bb = null;
        try { bb = t.getBoundingBox && t.getBoundingBox(); } catch (e) { bb = null; }
        if (bb) upd(bb.getX ? bb.getX() : bb.x, (bb.getX ? bb.getX() : bb.x) + (bb.getW ? bb.getW() : bb.w),
          bb.getY ? bb.getY() : bb.y, (bb.getY ? bb.getY() : bb.y) + (bb.getH ? bb.getH() : bb.h));
        // 빔 기둥 끝까지
        try {
          if (t.hasStem && t.hasStem() && t.getStemExtents) {
            var se = t.getStemExtents();
            var x = t.getStemX ? t.getStemX() : (bb ? bb.x : 0);
            upd(x - 2, x + 2, Math.min(se.topY, se.baseY) - 3, Math.max(se.topY, se.baseY) + 3);
          }
        } catch (e) { /* 무시 */ }
      });
    });
    return { skyLine: sky, bottomLine: bottom };
  }

  P.calculateSkyBottomLines = function () {
    try {
      var su = this.rules.SamplingUnit;
      this.musicSystems.forEach(function (sys) {
        sys.StaffLines.forEach(function (sl) {
          sl.SkyBottomLineCalculator.updateLines(sl.Measures.map(function (m) { return measureLines(m, su); }));
        });
      });
    } catch (e) {
      console.warn('빠른 간격 계산 실패, 원래 방식으로', e);
      return original.apply(this, arguments);
    }
  };
  P.__fastSky = true;
  window.__fastSkyOriginal = original;
})();
