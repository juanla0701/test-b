/* =========================================================================
   ConfidenceAdjust — 6단계: 유사 패턴 분석 결과를 confidence에 제한적으로 반영

   역할: 기존 신호가 이미 계산한 confidence를 "다시 계산"하지 않고,
   과거 유사 패턴의 성적을 근거로 별도의 보정값(delta)만 더한다.

   설계 원칙:
   - 기존 신호 점수(signals.js)·LONG/SHORT 판단·WIN/LOSS 판정·알림 조건을 건드리지 않는다.
     이 모듈은 "이미 나온 confidence 값"을 입력으로 받아 보정된 값을 반환하는 순수 함수다.
   - 쓰기 코드가 전혀 없다. 학습 데이터에 자동 저장하지 않으며 localStorage를 수정하지 않는다.
   - 그룹 격리와 미래 데이터 차단은 PatternSimilarity.eligiblePastSnapshots()가
     이미 보장하므로 그 규칙을 그대로 사용한다(중복 구현하지 않는다).
   - 안전장치: 표본 부족·유사도 미달·이상값이면 기존 confidence를 그대로 돌려준다.
     보정 폭은 CONFIG.SIM_ADJUST_MAX_DELTA(±10%p)를 절대 넘지 않는다.

   confidence 단위 주의:
   기존 PatternLearn.getConfidence()는 0~1을 반환하고 UI는 %로 표시한다.
   이 모듈은 0~100(%) 단위로 계산하며, 0~1 입력도 받을 수 있도록 헬퍼를 제공한다.
   ========================================================================= */
(function (root) {
  const CONFIG = root.CONFIG;
  const isNum = (v) => Number.isFinite(v);

  /* -----------------------------------------------------------------------
     현재 신호의 유사 패턴 지표를 모은다.
     유사도 기준(SIM_ADJUST_MIN_SIMILARITY) 이상인 패턴만 "핵심 표본"으로 사용한다.
     ----------------------------------------------------------------------- */
  function getSimilarityMetrics(currentSnapshot, options) {
    const opts = options || {};
    const minSim = isNum(opts.minSimilarity) ? opts.minSimilarity : CONFIG.SIM_ADJUST_MIN_SIMILARITY;
    const minSamples = isNum(opts.minSamples) ? opts.minSamples : CONFIG.SIM_ADJUST_MIN_SAMPLES;

    // 전체 비교 대상(유사도 필터 없음) — 참고용 수치
    const all = root.PatternSimilarity.findSimilarPatterns(currentSnapshot, { topN: Infinity });
    // 핵심 표본: 유사도 기준을 통과한 것만
    const core = all.allMatches.filter((m) => isNum(m.similarity) && m.similarity >= minSim);

    const coreWins = core.filter((m) => m.result === "WIN");
    const coreLosses = core.filter((m) => m.result === "LOSS");

    // 유사도 가중 승률: 유사도가 높은 패턴에 더 큰 비중을 준다
    let wWin = 0,
      wTotal = 0;
    core.forEach((m) => {
      const w = m.similarity / 100;
      wTotal += w;
      if (m.result === "WIN") wWin += w;
    });

    const similarities = core.map((m) => m.similarity);
    return {
      // 전체(필터 전) 비교 현황
      comparedCount: all.comparedCount,
      winCount: all.winCount,
      lossCount: all.lossCount,
      // 핵심 표본(유사도 기준 통과)
      coreCount: core.length,
      coreWinCount: coreWins.length,
      coreLossCount: coreLosses.length,
      similarityWeightedWinRate: wTotal > 0 ? (wWin / wTotal) * 100 : null,
      plainWinRate: core.length > 0 ? (coreWins.length / core.length) * 100 : null,
      averageSimilarity: similarities.length ? similarities.reduce((a, b) => a + b, 0) / similarities.length : null,
      topSimilarity: similarities.length ? Math.max.apply(null, similarities) : null,
      minSimilarityUsed: minSim,
      minSamplesUsed: minSamples,
      enough: core.length >= minSamples,
      topMatches: core.slice(0, isNum(opts.topN) ? opts.topN : 10),
    };
  }

  /* -----------------------------------------------------------------------
     보정값(delta, %p) 계산.
     중립 승률(기본 50%)에서 벗어난 정도에 비례해 보정하되, ±MAX_DELTA로 잘라낸다.
     표본/유사도 조건을 못 채우면 0(보정 없음)을 반환한다.
     ----------------------------------------------------------------------- */
  function computeAdjustment(metrics) {
    if (!metrics || !metrics.enough) return 0;
    const rate = metrics.similarityWeightedWinRate;
    if (!isNum(rate)) return 0;

    const neutral = CONFIG.SIM_ADJUST_NEUTRAL_WIN_RATE;
    const maxDelta = CONFIG.SIM_ADJUST_MAX_DELTA;

    // 승률이 중립에서 얼마나 벗어났는지를 -1~+1로 정규화한다.
    // (중립 50% 기준으로 100%면 +1, 0%면 -1)
    const span = Math.max(neutral, 100 - neutral); // 50
    const normalized = (rate - neutral) / span;
    const clamped = Math.max(-1, Math.min(1, normalized));
    return clamped * maxDelta; // 항상 ±maxDelta 이내
  }

  /* -----------------------------------------------------------------------
     기존 confidence(0~100)에 보정을 적용한다.
     - 유사 패턴 정보가 부족하거나 이상하면 기존 값을 그대로 반환한다.
     - 결과는 0~100으로 클램프하며, 보정 폭은 ±MAX_DELTA를 넘지 않는다.
     ----------------------------------------------------------------------- */
  function adjustConfidence(baseConfidence, currentSnapshot, options) {
    const base = isNum(baseConfidence) ? baseConfidence : null;
    // 기존 confidence가 없으면 보정 자체를 하지 않는다(기존 동작 유지)
    if (base === null) {
      return {
        baseConfidence: baseConfidence == null ? null : baseConfidence,
        adjustedConfidence: baseConfidence == null ? null : baseConfidence,
        similarityAdjustment: 0,
        applied: false,
        reason: "no-base-confidence",
        comparedCount: 0,
        winCount: 0,
        lossCount: 0,
        coreCount: 0,
        similarityWeightedWinRate: null,
        averageSimilarity: null,
        topSimilarity: null,
      };
    }

    let metrics;
    try {
      metrics = getSimilarityMetrics(currentSnapshot, options);
    } catch (e) {
      // 유사도 계산에 문제가 생기면 기존 confidence를 그대로 사용한다(안전 우선)
      console.error("similarity metrics failed", e);
      return {
        baseConfidence: base,
        adjustedConfidence: base,
        similarityAdjustment: 0,
        applied: false,
        reason: "similarity-error",
        comparedCount: 0,
        winCount: 0,
        lossCount: 0,
        coreCount: 0,
        similarityWeightedWinRate: null,
        averageSimilarity: null,
        topSimilarity: null,
      };
    }

    const delta = computeAdjustment(metrics);
    const applied = metrics.enough && delta !== 0;
    // 0~100 범위로 클램프 (보정 폭 자체는 computeAdjustment가 이미 ±MAX_DELTA로 제한)
    const adjusted = applied ? Math.max(0, Math.min(100, base + delta)) : base;

    return {
      baseConfidence: base,
      adjustedConfidence: adjusted,
      similarityAdjustment: applied ? adjusted - base : 0, // 클램프 후 실제 적용된 변화량
      applied,
      reason: applied ? "applied" : metrics.enough ? "neutral" : "insufficient-samples",
      // 디버깅/검증용 상세 (요구사항 13)
      comparedCount: metrics.comparedCount,
      winCount: metrics.winCount,
      lossCount: metrics.lossCount,
      coreCount: metrics.coreCount,
      coreWinCount: metrics.coreWinCount,
      coreLossCount: metrics.coreLossCount,
      similarityWeightedWinRate: metrics.similarityWeightedWinRate,
      plainWinRate: metrics.plainWinRate,
      averageSimilarity: metrics.averageSimilarity,
      topSimilarity: metrics.topSimilarity,
      minSimilarityUsed: metrics.minSimilarityUsed,
      minSamplesUsed: metrics.minSamplesUsed,
      maxDelta: CONFIG.SIM_ADJUST_MAX_DELTA,
    };
  }

  /* -----------------------------------------------------------------------
     0~1 단위 confidence(기존 PatternLearn.getConfidence 형식)를 그대로 받아
     보정한 뒤 다시 0~1로 돌려주는 편의 함수.
     ----------------------------------------------------------------------- */
  function adjustConfidenceUnit(baseConfidence01, currentSnapshot, options) {
    if (!isNum(baseConfidence01)) {
      const r = adjustConfidence(null, currentSnapshot, options);
      return Object.assign(r, { baseConfidence: baseConfidence01, adjustedConfidence: baseConfidence01 });
    }
    const r = adjustConfidence(baseConfidence01 * 100, currentSnapshot, options);
    return Object.assign({}, r, {
      baseConfidence: baseConfidence01,
      adjustedConfidence: r.adjustedConfidence / 100,
      // similarityAdjustment도 반환 단위(0~1)에 맞춘다 — 단위가 섞이지 않도록.
      // %p 값이 필요하면 similarityAdjustmentPercent를 쓴다.
      similarityAdjustment: r.similarityAdjustment / 100,
      similarityAdjustmentPercent: r.similarityAdjustment,
      baseConfidencePercent: r.baseConfidence,
      adjustedConfidencePercent: r.adjustedConfidence,
    });
  }

  /* -----------------------------------------------------------------------
     현재 신호(Signals.evaluate 결과)에 대한 보정 리포트를 만든다.
     기존 신호/알림을 바꾸지 않고 "조회"만 하는 디버깅용 API다.
     snapshot은 3단계 형식이어야 하며, 없으면 null을 반환한다.
     ----------------------------------------------------------------------- */
  function getReport(currentSnapshot, baseConfidence, options) {
    if (!currentSnapshot) return null;
    return adjustConfidence(baseConfidence, currentSnapshot, options);
  }

  /* -----------------------------------------------------------------------
     실제 신호 흐름 연결용 wrapper (app.js가 호출)

     흐름: 기존 Signals.evaluate() 결과(result) + recordPending()이 만든 pendingItem
     → 현재 신호의 snapshot 구성(PatternSnapshot.buildSnapshot, 저장하지 않음)
     → PatternSimilarity로 과거 유사 패턴 검색(그룹 격리·미래 차단은 그쪽이 보장)
     → confidence 보정값 계산 → 리포트 반환

     중요:
     - result(기존 신호 객체)를 수정하지 않는다. score/direction/isNewSignal 모두 그대로다.
     - base confidence는 기존 PatternLearn.getConfidence(patternKey)(0~1)를 그대로 읽는다.
       새로 계산하지 않으며, 단위 변환은 adjustConfidenceUnit이 처리한다.
     - 학습 데이터에 아무것도 저장하지 않는다(읽기 전용).
     - base confidence가 없으면(표본 부족 등) 보정하지 않고 그대로 null을 돌려준다.
     ----------------------------------------------------------------------- */
  function evaluateForSignal(result, direction, pendingItem, options) {
    if (!result || !direction) return null;
    const dirData = direction === "long" ? result.long : result.short;
    if (!dirData) return null;

    // 기존 신호가 이미 계산해 둔 base confidence (0~1 단위). 없으면 null.
    let baseUnit = null;
    try {
      const category =
        (pendingItem && pendingItem.category) ||
        (root.State && typeof root.State.getCategory === "function"
          ? root.State.getCategory(result.symbol)
          : CONFIG.DEFAULT_CATEGORY);
      const patternKey =
        (pendingItem && pendingItem.patternKey) ||
        root.PatternLearn.buildPatternKey(category, result.symbol, direction, dirData.conditions);
      baseUnit = root.PatternLearn.getConfidence(patternKey);
    } catch (e) {
      console.error("base confidence lookup failed", e);
      baseUnit = null;
    }

    // 현재 신호를 snapshot 형식으로 구성한다(저장하지 않음).
    // pendingItem이 없으면(학습 OFF·중복 신호 등) 비교용 항목을 직접 만든다.
    let currentSnapshot = null;
    try {
      const item = pendingItem || {
        // 비교 전용 임시 id. 저장하지 않으므로 기존 signalId 중복 방지 체계에 영향이 없다.
        // (buildSnapshot이 signalId를 요구하므로 null을 넘기면 snapshot이 만들어지지 않는다)
        signalId: `live:${result.symbol}:${direction}:${dirData.score}:${
          (result.entryTimes && result.entryTimes["1m"]) || result.updatedAt
        }`,
        symbol: result.symbol,
        category:
          root.State && typeof root.State.getCategory === "function"
            ? root.State.getCategory(result.symbol)
            : CONFIG.DEFAULT_CATEGORY,
        direction,
        score: dirData.score,
        signalTime: (result.entryTimes && result.entryTimes["1m"]) || result.updatedAt,
        entryTime: result.updatedAt,
        entryPrice: result.price,
        conditions: dirData.conditions,
        patternKey: null,
      };
      currentSnapshot = root.PatternSnapshot.buildSnapshot(item, result.tf);
    } catch (e) {
      console.error("current snapshot build failed", e);
      currentSnapshot = null;
    }

    if (!currentSnapshot) {
      return {
        symbol: result.symbol,
        direction,
        score: dirData.score,
        baseConfidence: baseUnit,
        adjustedConfidence: baseUnit,
        baseConfidencePercent: isNum(baseUnit) ? baseUnit * 100 : null,
        adjustedConfidencePercent: isNum(baseUnit) ? baseUnit * 100 : null,
        similarityAdjustment: 0,
        applied: false,
        reason: "no-current-snapshot",
        comparedCount: 0,
        winCount: 0,
        lossCount: 0,
        coreCount: 0,
        similarityWeightedWinRate: null,
        averageSimilarity: null,
        topSimilarity: null,
      };
    }

    // 0~1 단위를 유지하면서 보정한다(프로젝트 기존 표현 방식 보존).
    const r = adjustConfidenceUnit(baseUnit, currentSnapshot, options);
    return Object.assign(
      {
        symbol: result.symbol,
        direction,
        // 기존 점수/방향은 그대로 실어 보낸다(보정 때문에 바뀌지 않음을 명시)
        score: dirData.score,
      },
      r
    );
  }

  root.ConfidenceAdjust = {
    getSimilarityMetrics,
    computeAdjustment,
    adjustConfidence,
    adjustConfidenceUnit,
    getReport,
    evaluateForSignal,
  };
})(typeof window !== "undefined" ? window : globalThis);
