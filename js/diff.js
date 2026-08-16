"use strict";
const Diff = (function () {

  function splitParas(text) {
    const out = [];
    const src = String(text == null ? "" : text).replace(/\r\n/g, "\n");
    for (const line of src.split("\n")) {
      const s = line.replace(/\u3000/g, " ").trim();
      if (s) out.push(s);
    }
    return out;
  }

  function charCount(text) {
    return String(text == null ? "" : text).replace(/\s/g, "").length;
  }

  // 字符级 LCS diff：公共前缀/后缀裁剪 + 中间 LCS + 合并相邻同类操作
  // 返回 [[0|1|-1, text], ...]：0 相同、1 新增、-1 删除
  function charDiff(a, b) {
    const A = Array.from(String(a == null ? "" : a));
    const B = Array.from(String(b == null ? "" : b));
    const n = A.length, m = B.length;
    let pre = 0;
    const ml = Math.min(n, m);
    while (pre < ml && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < ml - pre && A[n - 1 - suf] === B[m - 1 - suf]) suf++;

    const ops = [];
    if (pre > 0) ops.push([0, A.slice(0, pre).join("")]);

    const midA = A.slice(pre, n - suf), midB = B.slice(pre, m - suf);
    const ln = midA.length, lm = midB.length;
    if (ln > 0 || lm > 0) {
      // 超长/超大 DP 直接整段标删增：防 O(n*m) 内存与耗时爆炸（~25MB/2500²）
      if (Math.max(ln, lm) > 2500 || ln * lm > 1000000) {
        if (ln > 0) ops.push([-1, midA.join("")]);
        if (lm > 0) ops.push([1, midB.join("")]);
      } else {
        const dp = Array.from({ length: ln + 1 }, () => new Uint32Array(lm + 1));
        for (let i = ln - 1; i >= 0; i--) {
          const r = i + 1;
          for (let j = lm - 1; j >= 0; j--) {
            dp[i][j] = midA[i] === midB[j]
              ? dp[r][j + 1] + 1
              : (dp[r][j] > dp[i][j + 1] ? dp[r][j] : dp[i][j + 1]);
          }
        }
        let i = 0, j = 0;
        while (i < ln || j < lm) {
          if (i < ln && j < lm && midA[i] === midB[j]) { ops.push([0, midA[i]]); i++; j++; }
          else if (j < lm && (i === ln || dp[i][j + 1] >= dp[i + 1][j])) { ops.push([1, midB[j]]); j++; }
          else { ops.push([-1, midA[i]]); i++; }
        }
      }
    }
    if (suf > 0) ops.push([0, A.slice(n - suf).join("")]);

    const merged = [];
    for (const [t, s] of ops) {
      const last = merged[merged.length - 1];
      if (last && last[0] === t) last[1] += s; else merged.push([t, s]);
    }
    return merged;
  }

  function similarity(a, b) {
    const sa = String(a == null ? "" : a), sb = String(b == null ? "" : b);
    if (!sa.length && !sb.length) return 1;
    let eq = 0;
    for (const [t, s] of charDiff(sa, sb)) if (t === 0) eq += s.length;
    return eq / Math.max(sa.length, sb.length);
  }

  function lcsPairs(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const r = i + 1;
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j]
          ? dp[r][j + 1] + 1
          : (dp[r][j] > dp[i][j + 1] ? dp[r][j] : dp[i][j + 1]);
      }
    }
    const pairs = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  // 生成"基准 → 版本"的合并文档（段落级 LCS 对齐 + 段落内字符 diff）
  // 条目类型：equal / delete / insert / inline
  //   equal   两端完全相同的段落
  //   delete  仅在基准中存在的段落（该版本删掉/改写）
  //   insert  仅在该版本中存在的段落
  //   inline  两段高度相似的段落对，段落内做字符 diff（ops）
  // 每条目带 pos（基准锚点行号，1 起；insert 取最近一条已有 lineA）
  function mergeDoc(baseText, verText, opts) {
    opts = opts || {};
    const inlineSim = opts.inlineSim == null ? 0.4 : opts.inlineSim;
    const A = splitParas(baseText), B = splitParas(verText);

    const matchedA = new Set(), pairMap = new Map();
    for (const p of lcsPairs(A, B)) { matchedA.add(p[0]); pairMap.set(p[0], p[1]); }
    const matchedB = new Set(pairMap.values());

    const out = [];
    let ai = 0, bj = 0, lastLine = 0;
    const push = (e) => {
      if (e.lineA) lastLine = e.lineA;
      e.pos = e.lineA || lastLine;
      out.push(e);
    };

    while (ai < A.length || bj < B.length) {
      if (ai < A.length && matchedA.has(ai)) {
        const bm = pairMap.get(ai);
        while (bj < bm) {
          push({ type: "insert", text: B[bj], lineA: "", lineB: bj + 1 });
          bj++;
        }
        push({ type: "equal", text: A[ai], lineA: ai + 1, lineB: bm + 1 });
        ai++;
        bj = bm + 1;
      } else {
        let g = ai; while (g < A.length && !matchedA.has(g)) g++;
        let h = bj; while (h < B.length && !matchedB.has(h)) h++;
        const nDel = g - ai, nIns = h - bj;
        const np = Math.min(nDel, nIns);
        for (let k = 0; k < np; k++) {
          const ta = A[ai + k], tb = B[bj + k];
          if (similarity(ta, tb) >= inlineSim) {
            push({
              type: "inline",
              textA: ta, textB: tb,
              lineA: ai + k + 1, lineB: bj + k + 1,
              ops: charDiff(ta, tb)
            });
          } else {
            push({ type: "delete", text: ta, lineA: ai + k + 1, lineB: "" });
            push({ type: "insert", text: tb, lineA: "", lineB: bj + k + 1 });
          }
        }
        for (let k = np; k < nDel; k++) push({ type: "delete", text: A[ai + k], lineA: ai + k + 1, lineB: "" });
        for (let k = np; k < nIns; k++) push({ type: "insert", text: B[bj + k], lineA: "", lineB: bj + k + 1 });
        ai = g; bj = h;
      }
    }
    return out;
  }

  function docStats(doc) {
    let same = 0, del = 0, add = 0;
    for (const e of doc) {
      if (e.type === "equal") same += e.text.length;
      else if (e.type === "inline") {
        for (const [o, s] of e.ops) {
          if (o === 0) same += s.length;
          else if (o === 1) add += s.length;
          else del += s.length;
        }
      }
      else if (e.type === "delete") del += e.text.length;
      else if (e.type === "insert") add += e.text.length;
    }
    return { same, del, add };
  }

  function isDiffEntry(e) {
    return e.type === "delete" || e.type === "insert" || e.type === "inline";
  }

  return {
    splitParas, charCount, charDiff, similarity, lcsPairs,
    mergeDoc, docStats, isDiffEntry
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Diff;
if (typeof globalThis !== "undefined") globalThis.Diff = Diff;
