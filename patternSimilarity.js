/* =========================================================================
   PatternSimilarity — 5단계: 현재 신호와 과거 확정 패턴의 유사도 비교

   목적: 새 자동 신호가 발생했을 때, 과거의 확정된 WIN/LOSS Snapshot 중
   "차트 움직임의 형태"가 가장 비슷한 패턴을 찾는다.

   설계 원칙:
   - 이 모듈에는 쓰기 코드가 전혀 없다. 3단계 snapshot을 읽기만 하므로
     원본 보존이 구조적으로 보장된다. 새 저장 구조도 만들지 않는다.
   - 비교 대상은 market + score + direction이 모두 같은 그룹으로 제한한다.
     (crypto/stock, 80/100, long/short가 절대 섞이지 않는다)
   - 미래 데이터 누수 방지: 현재 신호보다 signalTime이 늦은(미래) snapshot과
     현재 자신의 signalId는 비교 대상에서 제외한다.
   - 가격 정규화: 원본을 바꾸지 않고, 비교 시점에만 가격 의존 값을
     "해당 캔들 범위" 또는 "signalPrice" 기준 비율로 바꿔서 비교한다.
     따라서 BTC($100,000대)와 저가 코인($0.5대)도 형태 기준으로 비교된다.
   - 추가 Binance API 요청을 하지 않는다. 이미 저장된 snapshot만 사용한다.

   이번 단계는 조회/분석까지만 한다 — 점수·신호·알림·confidence를 일절 바꾸지 않는다.
   ========================================================================= */
(function (root) {
  const CONFIG = root.CONFIG;

  // 타임프레임 가중치: 1m이 실제 진입 타이밍이라 조금 더 크게 본다.
  const TF_WEIGHTS = { "15m": 0.3, "5m": 0.3, "1m": 0.4 };
  const DEFAULT_TOP_N = 10;

  const isNum = (v) => Number.isFinite(v);

  /* ---------------- 정규화 헬퍼 (원본을 바꾸지 않고 비교용 값만 생성) ---------------- */

  // 가격 단위 값을 기준값(scale)으로 나눠 비율로 만든다. scale이 없으면 비교 제외(null).
  function ratio(value, scale) {
    if (!isNum(value) || !isNum(scale) || scale === 0) return null;
    return value / scale;
  }

  // 캔들 하나를 "형태"로 정규화한다. 절대 가격이 아니라 범위 대비 비율만 쓴다.
  function normalizeCandle(c) {
    if (!c) return null;
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const bodyTop = Math.max(c.open, c.close);
    const bodyBottom = Math.min(c.open, c.close);
    return {
      bullish: c.close > c.open ? 1 : 0,
      // 범위 대비 비율 — 가격 규모와 무관한 형태값
      bodyRatio: ratio(body, range),
      upperWickRatio: ratio(c.high - bodyTop, range),
      lowerWickRatio: ratio(bodyBottom - c.low, range),
      // 변화율(%)은 이미 상대값
      changePercent: c.open > 0 ? ((c.close - c.open) / c.open) * 100 : null,
      // 캔들 범위를 종가 대비 비율로 (변동성 크기)
      rangePercent: c.close > 0 ? (range / c.close) * 100 : null,
    };
  }

  // 최근 10개 캔들을 상대적 움직임 시퀀스로 정규화한다.
  // 첫 캔들 종가를 기준(100)으로 하는 상대 경로 + 각 캔들의 형태값.
  function normalizeCandleSeries(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return null;
    const base = candles[0].close;
    if (!isNum(base) || base === 0) return null;
    // 거래량도 첫 캔들 거래량 대비 비율로 정규화(종목별 절대 거래량 차이 제거)
    const volBase = isNum(candles[0].volume) && candles[0].volume > 0 ? candles[0].volume : null;
    return candles.map((c) => {
      const shape = normalizeCandle(c);
      return {
        // 첫 캔들 대비 누적 변화율(%) — 차트가 그린 "경로의 형태"
        pathPercent: ((c.close - base) / base) * 100,
        volumeRatio: volBase ? ratio(c.volume, volBase) : null,
        // HA 방향(상대값)
        haBullish: c.haBullish === null || c.haBullish === undefined ? null : c.haBullish ? 1 : 0,
        // HA 몸통을 종가 대비 비율로
        haBodyPercent:
          isNum(c.haOpen) && isNum(c.haClose) && isNum(c.close) && c.close !== 0
            ? (Math.abs(c.haClose - c.haOpen) / c.close) * 100
            : null,
        shape,
      };
    });
  }

  /* ---------------- 유사도 계산 기본 ---------------- */

  // 두 수치를 비교해 0~1 유사도를 만든다. tolerance는 "이 정도 차이면 절반쯤 다르다"는 기준.
  function numSim(a, b, tolerance) {
    if (!isNum(a) || !isNum(b)) return null; // 한쪽이라도 없으면 비교에서 제외
    const diff = Math.abs(a - b);
    return 1 / (1 + diff / tolerance);
  }

  // 불리언(또는 0/1) 비교: 같으면 1, 다르면 0
  function boolSim(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return null;
    return !!a === !!b ? 1 : 0;
  }

  // 유효한 항목만 가중 평균한다. 비교 불가(null) 항목은 자동으로 제외된다.
  function weightedMean(parts) {
    let sum = 0,
      wsum = 0;
    parts.forEach(([score, weight]) => {
      if (score === null || score === undefined || !isNum(score)) return;
      sum += score * weight;
      wsum += weight;
    });
    return wsum > 0 ? sum / wsum : null;
  }

  /* ---------------- 캔들 시퀀스 유사도 (요구사항 7) ---------------- */

  function candleSeriesSimilarity(a, b) {
    const sa = normalizeCandleSeries(a);
    const sb = normalizeCandleSeries(b);
    if (!sa || !sb) return null;
    const n = Math.min(sa.length, sb.length);
    if (n === 0) return null;
    // 두 시퀀스의 끝(최신)을 맞춰서 비교한다 — 최근 움직임이 중요하므로
    const aa = sa.slice(-n);
    const bb = sb.slice(-n);
    const perCandle = [];
    for (let i = 0; i < n; i++) {
      const x = aa[i],
        y = bb[i];
      const parts = [
        // 경로 형태 (첫 캔들 대비 누적 변화율) — 가장 중요
        [numSim(x.pathPercent, y.pathPercent, 1.0), 3],
        [boolSim(x.haBullish, y.haBullish), 1.5],
        [numSim(x.haBodyPercent, y.haBodyPercent, 0.5), 1],
        [numSim(x.volumeRatio, y.volumeRatio, 0.5), 1],
      ];
      if (x.shape && y.shape) {
        parts.push([boolSim(x.shape.bullish, y.shape.bullish), 1.5]);
        parts.push([numSim(x.shape.bodyRatio, y.shape.bodyRatio, 0.25), 1.5]);
        parts.push([numSim(x.shape.upperWickRatio, y.shape.upperWickRatio, 0.25), 1]);
        parts.push([numSim(x.shape.lowerWickRatio, y.shape.lowerWickRatio, 0.25), 1]);
        parts.push([numSim(x.shape.changePercent, y.shape.changePercent, 0.5), 1.5]);
        parts.push([numSim(x.shape.rangePercent, y.shape.rangePercent, 0.5), 1]);
      }
      const m = weightedMean(parts);
      if (m !== null) perCandle.push(m);
    }
    if (perCandle.length === 0) return null;
    return perCandle.reduce((s, v) => s + v, 0) / perCandle.length;
  }

  /* ---------------- 타임프레임 유사도 (요구사항 6) ---------------- */

  // MACD는 절대 가격 스케일에 비례하므로 signalPrice 기준으로 정규화해서 비교한다.
  function macdScaled(value, signalPrice) {
    if (!isNum(value) || !isNum(signalPrice) || signalPrice === 0) return null;
    return (value / signalPrice) * 1000; // 스케일만 맞추기 위한 상수배(비교용)
  }

  function timeframeSimilarity(stA, stB, priceA, priceB) {
    if (!stA || !stB) return null;

    const candleA = stA.candle,
      candleB = stB.candle;
    // 현재 캔들 형태: 범위 대비 비율로 정규화해서 비교
    const rangeA = isNum(candleA && candleA.range) ? candleA.range : null;
    const rangeB = isNum(candleB && candleB.range) ? candleB.range : null;

    const parts = [
      // --- Heikin-Ashi 상태 ---
      [boolSim(stA.haBullish, stB.haBullish), 2],
      [boolSim(stA.haFlipped, stB.haFlipped), 1.5],
      // --- MACD (가격 정규화 후 비교) ---
      [numSim(macdScaled(stA.macdDif, priceA), macdScaled(stB.macdDif, priceB), 0.5), 1.5],
      [numSim(macdScaled(stA.macdDea, priceA), macdScaled(stB.macdDea, priceB), 0.5), 1],
      [numSim(macdScaled(stA.macdDiff, priceA), macdScaled(stB.macdDiff, priceB), 0.3), 2],
      [numSim(macdScaled(stA.macdDifDelta, priceA), macdScaled(stB.macdDifDelta, priceB), 0.3), 1],
      [boolSim(stA.macdGoldenCross, stB.macdGoldenCross), 1.5],
      [boolSim(stA.macdDeadCross, stB.macdDeadCross), 1.5],
      [boolSim(stA.macdAboveSignal, stB.macdAboveSignal), 1],
      // --- RSI (이미 0~100 상대값이라 그대로 비교) ---
      [numSim(stA.rsi, stB.rsi, 10), 2],
      [numSim(stA.rsiDelta, stB.rsiDelta, 5), 1],
      [boolSim(stA.rsiRising, stB.rsiRising), 1],
      // --- 거래량 (변화율은 이미 상대값) ---
      [numSim(stA.volumeChangePercent, stB.volumeChangePercent, 50), 1],
      // --- 현재 캔들 형태 (범위 대비 비율) ---
      [numSim(ratio(candleA && candleA.body, rangeA), ratio(candleB && candleB.body, rangeB), 0.25), 1.5],
      [numSim(ratio(candleA && candleA.upperWick, rangeA), ratio(candleB && candleB.upperWick, rangeB), 0.25), 1],
      [numSim(ratio(candleA && candleA.lowerWick, rangeA), ratio(candleB && candleB.lowerWick, rangeB), 0.25), 1],
      [numSim(candleA && candleA.changePercent, candleB && candleB.changePercent, 0.5), 1.5],
      [boolSim(candleA && candleA.bullish, candleB && candleB.bullish), 1.5],
      // 캔들 범위를 가격 대비 비율로 (변동성 규모)
      [numSim(ratio(rangeA, priceA), ratio(rangeB, priceB), 0.005), 1],
      // --- 최근 10개 캔들 형태 (가장 비중 큼) ---
      [candleSeriesSimilarity(stA.candles, stB.candles), 4],
    ];
    return weightedMean(parts);
  }

  // 신호 조건(trend15/trend5/ha1Flip/macdCross) 일치도
  function conditionsSimilarity(a, b) {
    if (!a || !b) return null;
    const keys = ["trend15", "trend5", "ha1Flip", "macdCross"];
    const parts = keys.map((k) => [boolSim(a[k], b[k]), 1]);
    return weightedMean(parts);
  }

  /* ---------------- 전체 유사도 (0~100) ---------------- */

  function computeSimilarity(current, past) {
    const pc = current.signalPrice,
      pp = past.signalPrice;
    const tf15 = timeframeSimilarity(current.tf15, past.tf15, pc, pp);
    const tf5 = timeframeSimilarity(current.tf5, past.tf5, pc, pp);
    const tf1 = timeframeSimilarity(current.tf1, past.tf1, pc, pp);
    const cond = conditionsSimilarity(current.conditions, past.conditions);

    // 타임프레임 가중 결합 (15m 30% / 5m 30% / 1m 40%)
    const overall = weightedMean([
      [tf15, TF_WEIGHTS["15m"]],
      [tf5, TF_WEIGHTS["5m"]],
      [tf1, TF_WEIGHTS["1m"]],
      // 조건 일치도는 보조 지표로 소폭 반영
      [cond, 0.15],
    ]);

    const to100 = (v) => (v === null ? null : Math.max(0, Math.min(100, v * 100)));
    return {
      similarity: to100(overall),
      breakdown: {
        tf15: to100(tf15),
        tf5: to100(tf5),
        tf1: to100(tf1),
        conditions: to100(cond),
      },
    };
  }

  /* ---------------- 비교 대상 선별 (요구사항 2, 3) ---------------- */

  function eligiblePastSnapshots(current) {
    if (!current) return [];
    return root.PatternSnapshot.getAll().filter((s) => {
      // 결과가 확정된 것만 (result:null 제외)
      if (s.result !== "WIN" && s.result !== "LOSS") return false;
      // 같은 그룹만 비교 (market/score/direction 중 하나라도 다르면 제외)
      if (s.market !== current.market) return false;
      if (s.score !== current.score) return false;
      if (s.direction !== current.direction) return false;
      // 자기 자신 제외
      if (current.signalId && s.signalId === current.signalId) return false;
      // 미래 데이터 누수 방지: 현재 신호보다 나중에 발생한 패턴은 사용하지 않는다
      if (isNum(current.signalTime) && isNum(s.signalTime) && s.signalTime >= current.signalTime) return false;
      return true;
    });
  }

  /* ---------------- 공개 API ---------------- */

  // 현재 snapshot과 유사한 과거 패턴을 유사도 내림차순으로 반환한다.
  function findSimilarPatterns(currentSnapshot, options) {
    const opts = options || {};
    const topN = opts.topN || DEFAULT_TOP_N;
    const pool = eligiblePastSnapshots(currentSnapshot);

    const scored = pool
      .map((s) => {
        const { similarity, breakdown } = computeSimilarity(currentSnapshot, s);
        return {
          similarity,
          breakdown,
          result: s.result,
          symbol: s.symbol,
          signalId: s.signalId,
          signalTime: s.signalTime,
          score: s.score,
          direction: s.direction,
          market: s.market,
          signalPrice: s.signalPrice,
          pnlPercent: s.pnlPercent,
        };
      })
      .filter((m) => m.similarity !== null)
      // 유사도 높은 순
      .sort((a, b) => b.similarity - a.similarity);

    const filtered =
      isNum(opts.minSimilarity) ? scored.filter((m) => m.similarity >= opts.minSimilarity) : scored;

    return {
      current: currentSnapshot
        ? {
            signalId: currentSnapshot.signalId,
            symbol: currentSnapshot.symbol,
            market: currentSnapshot.market,
            score: currentSnapshot.score,
            direction: currentSnapshot.direction,
            signalTime: currentSnapshot.signalTime,
            signalPrice: currentSnapshot.signalPrice,
          }
        : null,
      comparedCount: filtered.length,
      winCount: filtered.filter((m) => m.result === "WIN").length,
      lossCount: filtered.filter((m) => m.result === "LOSS").length,
      matches: filtered.slice(0, topN),
      allMatches: filtered, // 통계 계산용(상위 N에 잘리지 않은 전체)
    };
  }

  // 유사도 가중 승률 등 통계. 표본이 적으면 enough:false로 알린다.
  function getSimilarityStats(currentSnapshot, options) {
    const opts = options || {};
    const found = findSimilarPatterns(currentSnapshot, opts);
    const all = found.allMatches;

    // 유사도가 높은 패턴에 더 큰 가중치를 준다(단순 개수 비율이 아님).
    let wWin = 0,
      wTotal = 0;
    all.forEach((m) => {
      const w = m.similarity / 100; // 0~1
      wTotal += w;
      if (m.result === "WIN") wWin += w;
    });

    const avgSim =
      all.length > 0 ? all.reduce((s, m) => s + m.similarity, 0) / all.length : null;
    const minSamples = isNum(opts.minSamples) ? opts.minSamples : CONFIG.SCORE_PERF_MIN_SAMPLES;

    return {
      comparedCount: all.length,
      winCount: found.winCount,
      lossCount: found.lossCount,
      // 표본이 부족하면 억지로 신뢰도를 만들지 않는다
      similarityWeightedWinRate: wTotal > 0 ? (wWin / wTotal) * 100 : null,
      plainWinRate: all.length > 0 ? (found.winCount / all.length) * 100 : null,
      averageSimilarity: avgSim,
      topMatches: found.matches,
      enough: all.length >= minSamples,
    };
  }

  // 성공 패턴만 / 실패 패턴만 유사도 순으로 (요구사항 10)
  function getSimilarWinningPatterns(currentSnapshot, options) {
    const opts = options || {};
    const found = findSimilarPatterns(currentSnapshot, Object.assign({}, opts, { topN: Infinity }));
    const wins = found.allMatches.filter((m) => m.result === "WIN");
    return wins.slice(0, opts.topN || DEFAULT_TOP_N);
  }

  function getSimilarLosingPatterns(currentSnapshot, options) {
    const opts = options || {};
    const found = findSimilarPatterns(currentSnapshot, Object.assign({}, opts, { topN: Infinity }));
    const losses = found.allMatches.filter((m) => m.result === "LOSS");
    return losses.slice(0, opts.topN || DEFAULT_TOP_N);
  }

  root.PatternSimilarity = {
    findSimilarPatterns,
    getSimilarityStats,
    getSimilarWinningPatterns,
    getSimilarLosingPatterns,
    computeSimilarity,
    eligiblePastSnapshots,
    // 테스트/확장용 내부 헬퍼
    normalizeCandle,
    normalizeCandleSeries,
    candleSeriesSimilarity,
    timeframeSimilarity,
    TF_WEIGHTS,
  };
})(typeof window !== "undefined" ? window : globalThis);
