import LAWS from "./laws.json";

export const LAW_NAME = {
  R: "산업안전보건기준에 관한 규칙",
  L: "산업안전보건법",
  S: "산업안전보건법 시행규칙",
  E: "산업안전보건법 시행령",
};
const WEIGHT = { R: 1.0, L: 0.8, S: 0.6, E: 0.4 };

// 현장 용어 → 법령 용어
const SYN = {
  "정리정돈": ["전도", "청결", "통로", "넘어지"],
  "넘어짐": ["전도", "넘어지"], "전도": ["전도", "넘어지"],
  "미끄러짐": ["미끄러", "전도"],
  "전선": ["전선", "배선", "이동전선"],
  "가설전기": ["임시배선", "이동전선", "누전차단기", "배선", "분전반"],
  "임시전기": ["임시배선", "이동전선", "누전차단기", "배선"],
  "분전반": ["분전반", "충전부", "누전차단기"],
  "콘센트": ["꽂음접속기", "접속기"], "멀티탭": ["꽂음접속기", "접속기"],
  "감전": ["감전", "충전부", "누전차단기", "접지"],
  "누전": ["누전차단기", "접지"],
  "접지": ["접지"],
  "화재": ["화재", "인화성", "소화"],
  "경고표지": ["경고표시", "물질안전보건자료"], "경고표시": ["경고표시", "물질안전보건자료"],
  "msds": ["물질안전보건자료"],
  "유해위험물질": ["물질안전보건자료", "경고표시", "유해물질"],
  "화학물질": ["물질안전보건자료", "경고표시", "유해물질"],
  "추락": ["추락", "작업발판", "안전난간", "개구부"],
  "개구부": ["개구부", "덮개", "안전난간"],
  "난간": ["안전난간"], "안전난간": ["안전난간"],
  "낙하": ["낙하물", "낙하"], "낙하물": ["낙하물", "낙하"],
  "말비계": ["말비계"],
  "낙석방지대": ["말비계", "양측끝부분"],
  "단부": ["끝부분", "끝이나"],
  "사다리": ["사다리"],
  "비계": ["비계", "작업발판"],
  "작업발판": ["작업발판"],
  "안전모": ["보호구", "안전모"], "안전대": ["안전대", "보호구"], "보호구": ["보호구"],
  "그라인더": ["연삭숫돌", "덮개"], "연삭기": ["연삭숫돌", "덮개"],
  "용접": ["용접", "불꽃", "화재감시자"],
  "소화기": ["소화설비", "소화기"],
  "적치": ["적재", "넘어지", "무너"], "적재": ["적재", "넘어지", "무너"],
  "통로": ["통로"],
  "조명": ["조명", "조도"],
  "거푸집": ["거푸집"], "동바리": ["동바리"],
  "굴착": ["굴착"], "흙막이": ["흙막이"],
  "크레인": ["크레인"], "양중": ["양중기"], "줄걸이": ["와이어로프", "달기"],
  "지게차": ["지게차"], "굴착기": ["굴착기"],
  "밀폐공간": ["밀폐공간", "산소결핍"],
};
const STOP = new Set(["불량","미흡","위험","발생","미설치","미부착","미착용","부적합","사용","작업","설치","상태","인한","따른","관리","부족","필요","조치","확인","현장","근로자","및","등"]);
const PARTICLE = /(으로인한|에따른|에서|에게|에는|으로|로|을|를|이|가|은|는|의|에|과|와|도)$/;

function compact(s) { return (s || "").replace(/\s+/g, "").toLowerCase(); }

let _idx = null;
function index() {
  if (!_idx) _idx = LAWS.map(a => ({ ...a, ct: compact(a.t), cx: compact(a.x) }));
  return _idx;
}

export function terms(note, extra = []) {
  const raw = (note || "").split(/[^가-힣a-zA-Z0-9]+/).filter(Boolean)
    .concat(extra.map(e => String(e)));
  const set = new Set();
  for (let w of raw) {
    w = compact(w);
    // 붙어 있는 복합어에서 사전 키 찾기 (예: "가설전기불량")
    for (const k of Object.keys(SYN)) if (w.includes(k)) SYN[k].forEach(s => set.add(compact(s)));
    w = w.replace(PARTICLE, "");
    if (w.length >= 2 && !STOP.has(w)) set.add(w);
  }
  return [...set];
}

export function search(note, extra = [], limits = { R: 14, L: 4, S: 3, E: 1 }) {
  const ts = terms(note, extra);
  if (!ts.length) return [];
  const scored = [];
  for (const a of index()) {
    let s = 0;
    for (const t of ts) {
      if (a.ct.includes(t)) s += 10;
      const c = a.cx.split(t).length - 1;
      if (c) s += Math.min(3, c);
    }
    if (s > 0) scored.push({ a, s: s * WEIGHT[a.k] });
  }
  scored.sort((x, y) => y.s - x.s);
  const out = [], cnt = { R: 0, L: 0, S: 0, E: 0 };
  for (const { a } of scored) {
    if (cnt[a.k] >= (limits[a.k] || 0)) continue;
    cnt[a.k]++; out.push(a);
  }
  return out;
}

export function lawId(a) { return a.k + a.n; }
export function lawLabel(a) {
  const no = a.n.includes("의") ? `제${a.n.replace("의", "조의")}` : `제${a.n}조`;
  return `${LAW_NAME[a.k]} ${no}(${a.t})`;
}
