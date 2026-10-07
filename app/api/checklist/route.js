import JSZip from "jszip";
import { requireUser } from "../_auth";
import { ITEMS, SAMPLES } from "./items";
import { TEMPLATE_B64 } from "./template";
import { checkFacts, CHECK_ADVICE } from "../../checkItems";
export const runtime = "nodejs";
export const maxDuration = 300;

const STAGE = { DIAG: "수준진단", I: "I단계", S: "S단계", P: "P단계" };

const EXCLUDE = new Set([4]); // A-1 사전의무교육: 작성·점검 대상 제외
const WORK = ITEMS.filter(it => !EXCLUDE.has(it.r));

// 행 높이에 따른 칸당 분량 (사장님 작성본 기준: 높이 150 = 2줄·90자)
let _heights = null;
async function rowHeights() {
  if (_heights) return _heights;
  const zip = await JSZip.loadAsync(Buffer.from(TEMPLATE_B64, "base64"));
  const xml = await zip.file("xl/worksheets/sheet2.xml").async("string");
  _heights = {};
  for (const m of xml.matchAll(/<row r="(\d+)"[^>]*?ht="([\d.]+)"/g)) _heights[Number(m[1])] = Number(m[2]);
  return _heights;
}
function budgetOf(h) {
  const ht = h || 150;
  return { lines: ht >= 230 ? 3 : 2, chars: Math.max(80, Math.round(90 * ht / 150)), perLine: 45 };
}
function overBudget(text, bud) {
  const t = (text || "").trim(); if (!t) return false;
  const ls = t.split("\n").filter(x => x.trim());
  return ls.length > bud.lines || t.length > bud.chars || ls.some(l => l.length > bud.perLine + 5);
}

const STYLE_RULES = `[문체 규칙]
1. 줄마다 "- 본사 : …" 또는 "- 현장 : …"으로 시작하는 짧은 명사형 문장. "본사/현장"은 실제로 둘 다 해당할 때만 쓴다. 현장 방문에서 들은 본사 일은 "본사"로 쓴다.
2. [현황 및 문제점]에는 업체의 현재 상태만 사실대로 쓴다. 상태는 셋 중 하나로 판단한다.
   - 잘 하고 있음 → "~ 운영 중", "~ 관리 중", "~ 게시 중", "~ 작성 완료"
   - 하고 있으나 보완 필요 → "~ 운영 중이나 ~ 미흡"
   - 하지 않음 → "~ 미수립", "~ 미실시", "~ 미운영"
   잘 하고 있는 것을 미흡으로 바꾸지 않는다. "확인", "미확인", "권고 상태"처럼 지도사의 행동은 현황에 쓰지 않는다.
3. [개선대책]에는 회의에서 지도사가 제안한 방법을 짧게 쓴다.
   - 잘 하고 있으면 "- 현행 유지" 또는 "- 현행 유지, ~ 권고"
   - 보완·미흡이면 무엇을 어떻게 할지 + 근거 남기는 방법(교육일지·TBM 일지 기록 등)
4. 공식 문서 표현: "카카오톡"은 "SNS". 회의 중 사담·진행상황(메일 보냄 등)은 쓰지 않는다.
5. 음성인식 원문이라 오탈자가 있으니 문맥으로 이해한다.

[견본 — 이 길이와 어조를 따른다]
현황: - 현장 : 노사협의체 결과물 도급사 플랫폼 및 현장 게시판 게시 중
개선대책: - 현행 유지, 정기교육 시 결과 전달 및 교육일지 기록 권고

현황: - 현장 : 도급사(현대건설) 모의훈련 참여 및 훈련결과보고서 수령·보관 관리 중
개선대책: - 현장 : 현행 유지, 도급사 훈련 불참 시 약식 자체훈련 실시 및 결과보고서 작성

현황: - 본사 : 경영책임자의 반기 안전보건관리체계 운영점검 미실시
개선대책: - 본사 : 반기 1회 경영책임자 점검 실시 및 결과 피드백·개선조치`;

function draftPrompt({ company, stage, transcript, prev, answers, checks }, items, heights) {
  const list = items.map(it => {
    const bud = budgetOf(heights[it.r]);
    const facts = checks ? checkFacts(it.r, checks) : [];
    const adv = CHECK_ADVICE[String(it.r)];
    return `${it.r} | ${it.ind} | ${it.crit.replace(/\n/g, " ")} | 장소: ${it.where} | 분량: 칸당 최대 ${bud.lines}줄·${bud.chars}자, 줄당 ${bud.perLine}자`
      + (facts.length ? `\n   [현장 체크] ${facts.join(" / ")}` : "")
      + (adv ? `\n   [권고 예시] ${adv}` : "");
  }).join("\n");
  const sample = SAMPLES.map(s => `[현황] ${s.i}\n[개선대책] ${s.j}`).join("\n\n");
  const rowSet = new Set(items.map(it => String(it.r)));
  const prevRows = Object.entries(prev || {}).filter(([r, v]) => rowSet.has(String(r)) && v && (v.i || v.j));
  const prevText = prevRows.map(([r, v]) => `${r}\n현황: ${v.i || "-"}\n개선대책: ${v.j || "-"}`).join("\n\n");
  const ans = (Array.isArray(answers) ? answers : []).filter(a => a && a.a && String(a.a).trim() && (!a.r || rowSet.has(String(a.r))));
  const ansText = ans.map(a => a.r ? `${a.r}행 | 질문: ${a.q} | 지도사 답: ${a.a}` : `회의록 정정 | 원문: "${a.quote}" | 지도사 답: ${a.a}`).join("\n");

  return `당신은 건설업 안전보건관리체계 구축 컨설팅을 수행하는 산업안전지도사의 보조자입니다.
업체: ${company || ""} / 단계: ${STAGE[stage] || stage}

아래 회의록과 자료를 근거로, 아래 "세부기준" 각 행의 [현황 및 문제점](i)과 [개선대책](j)을 씁니다. 평가점수는 쓰지 않습니다.
${ansText ? `\n[지도사 확인 답변 — 회의록보다 우선하는 근거]\n${ansText}\n` : ""}
${STYLE_RULES}

[근거 우선순위]
1) [현장 체크] — 지도사가 현장에서 직접 판정한 사실. 현황은 반드시 이것을 따른다: 적정 → "~ 운영 중/관리 중/작성 완료", 보완 → "~ 운영 중이나 ~ 미흡"(메모를 이유로 사용), 미수립 → "~ 미수립·미실시", 해당없음 → 언급하지 않음.
2) 지도사 확인 답변
3) 회의록
개선대책은 [현장 체크]의 "권고 메모" → 회의록에서 지도사가 제안한 방법 → [권고 예시] 순으로 근거를 쓴다. 모두 적정이면 "- 현행 유지".
[현장 체크]가 있는 행은 "nb": false.

[작성 범위]
- ${prevText ? "아래 \"앞 단계 작성 내용\"이 있는 행은 이번 회의에서 달라진 경우에만 출력한다(달라지지 않으면 출력하지 않음). 앞 단계 내용이 없는 행은 반드시 출력한다." : "세부기준의 모든 행을 빠짐없이 출력한다."}
- 회의록·답변에 근거가 있으면 그 내용으로 쓰고 "nb": false.
- 근거가 전혀 없으면 비워두지 말고, 평가기준·요구문서에 비추어 미이행 상태로 현황을 쓰고(예: "- 본사 : 경영책임자의 반기 안전보건관리체계 운영점검 미실시") 평가기준에 맞는 개선대책을 쓴 뒤 "nb": true로 표시한다.
- 각 행의 "분량" 제한을 반드시 지킨다. 넘칠 것 같으면 핵심만 남긴다.

[사장님 기존 작성 문장 참고]
${sample}

세부기준 (행번호 | 지표 | 기준 | 장소 | 요구문서 | 분량):
${list}
${prevText ? `\n앞 단계 작성 내용:\n${prevText}\n` : ""}
회의록:
${(transcript || "").slice(0, 150000)}

JSON 하나로만 답한다. 형식:
{"rows":[{"r":5,"i":"- 본사 : …","j":"- 현행 유지","nb":false}]}`;
}

function shrinkPrompt(rows, heights) {
  const list = rows.map(x => {
    const bud = budgetOf(heights[x.r]);
    return `${x.r} | 분량: 최대 ${bud.lines}줄·${bud.chars}자, 줄당 ${bud.perLine}자\n현황: ${x.i}\n개선대책: ${x.j}`;
  }).join("\n\n");
  return `다음 평가지표 문장들이 엑셀 칸에 들어가지 않습니다. 의미와 "- 본사 : / - 현장 :" 형식, 어조는 그대로 두고 각 행의 분량 제한 안으로 줄여주세요. 덜 중요한 수식어부터 줄이고, 줄 수가 넘치면 비슷한 줄을 합칩니다.

${list}

JSON 하나로만 답한다. 형식: {"rows":[{"r":5,"i":"…","j":"…"}]}`;
}

function reviewPrompt({ company, stage, visitLabel, location, transcript, prev, prep }) {
  const rel = WORK.filter(it => location === "ALL" || it.where === "본사/현장" || it.where === location);
  const list = rel.map(it =>
    `${it.r} | ${it.ind} | ${it.crit.replace(/\n/g, " ")} | 평가방법: ${it.method} | 요구문서: ${it.docs || "-"}`).join("\n");
  const prevRows = Object.entries(prev || {}).filter(([, v]) => v && (v.i || v.j));
  const prevText = prevRows.map(([r, v]) => `${r} | 현황: ${(v.i || "").replace(/\n/g, " ")}`).join("\n");
  return `당신은 건설업 안전보건관리체계 구축 컨설팅을 수행하는 산업안전지도사의 보조자입니다.
업체: ${company || ""} / 단계: ${STAGE[stage] || stage} / 이번 방문: ${visitLabel || ""}

지금은 현장 방문이 끝나기 직전입니다. 평가지표 초안을 쓰기 전에, 지도사가 현장을 떠나기 전 확인해야 할 것을 찾아주세요.

[해야 할 일]
A. 아래 "세부기준" 각각에 대해 회의록에 근거가 있는지 판정한다. 배점 항목이 나뉘어 있으면(예: 문서화 1점 + 실행계획 1점) 항목 단위까지 본다.
   - ok: 회의록에 그 기준(배점 항목 포함)을 판단할 근거가 분명히 있음
   - unclear: 언급은 있으나 판단하기에 부족함(일부 배점 항목만 언급, 요구문서를 실제로 확인했는지 불명, 본사인지 현장인지 불명, 결론 없이 끝남 등)
   - missing: 회의록에 전혀 다뤄지지 않음
   평가방법이 "문서검토"인데 요구문서를 실제로 봤다는 말이 없으면 unclear로 본다.
B. 앞 단계에서 미흡했던 기준과 준비자료에서 이번에 확인하기로 한 사항이 이번 회의에서 다뤄졌는지도 위 판정에 반영한다.
C. 회의록 자체의 문제를 찾는다(음성인식 회의록이라 오류가 있음): 잘못 알아들은 것으로 의심되는 말, 의미가 불분명한 숫자·날짜, 중간에 끊긴 문장, 누가(본사/현장/원청) 한 일인지 불분명한 문장. 평가지표 작성에 영향을 주는 것만, 원문을 그대로 짧게 인용한다.

[질문 작성 규칙]
- 질문은 지도사가 현장에서 담당자에게 바로 묻거나 서류를 보고 답할 수 있게 짧고 구체적으로 쓴다.
- 예: "A-2 실행계획 — 목표는 확인했다는 말이 있으나 세부추진계획 수립 여부 언급이 없습니다. 수립되어 있나요?"
- 사담·인사·진행상 대화는 문제 삼지 않는다.

세부기준 (행번호 | 지표 | 기준 | 평가방법 | 요구문서):
${list}
${prevText ? `\n앞 단계 현황:\n${prevText}\n` : ""}${prep ? `\n준비자료(이번에 확인하기로 한 사항 포함):\n${String(prep).slice(0, 6000)}\n` : ""}
회의록:
${(transcript || "").slice(0, 150000)}

JSON 하나로만 답한다. ok는 행번호만, unclear·missing은 질문과 함께. 형식:
{"ok":[5,6],"unclear":[{"r":7,"q":"…"}],"missing":[{"r":9,"q":"…"}],"issues":[{"quote":"회의록 원문 인용","guess":"이렇게 이해함","q":"맞나요? 등 확인 질문"}]}`;
}

async function askClaude(key, prompt, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return { error: "AI 서버 오류", detail: (await r.text()).slice(0, 300) };
  const d = await r.json();
  const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  try { return { json: JSON.parse(m[0]) }; } catch { return { error: "AI 결과를 해석하지 못했습니다." }; }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// I·J열 칸 스타일을 "바탕 없음"과 "노란 바탕" 두 벌로 복제
function prepareStyles(stylesXml) {
  let xml = stylesXml;
  // fills: 노란색 채우기 찾기(없으면 추가)
  const fillsM = xml.match(/<fills count="(\d+)">([\s\S]*?)<\/fills>/);
  const fills = fillsM[2].match(/<fill>[\s\S]*?<\/fill>|<fill\/>/g) || [];
  let yellow = fills.findIndex(f => /patternType="solid"/.test(f) && /rgb="FFFFFF00"/i.test(f));
  if (yellow < 0) {
    yellow = fills.length;
    const add = '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>';
    xml = xml.replace(fillsM[0], `<fills count="${fills.length + 1}">${fillsM[2]}${add}</fills>`);
  }
  const xfsM = xml.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  const xfs = xfsM[2].match(/<xf [^>]*?\/>|<xf [^>]*?>[\s\S]*?<\/xf>/g) || [];
  const extra = [];
  const cache = {};
  const variant = (s, hl) => {
    const k = s + ":" + (hl ? 1 : 0);
    if (cache[k] != null) return cache[k];
    const base = xfs[s]; if (!base) return s;
    let x = base.replace(/\sfillId="\d+"/, "").replace(/\sapplyFill="\d"/, "");
    x = x.replace(/^<xf /, `<xf fillId="${hl ? yellow : 0}" applyFill="1" `);
    cache[k] = xfs.length + extra.length;
    extra.push(x);
    return cache[k];
  };
  const finish = () => xml.replace(xfsM[0], `<cellXfs count="${xfs.length + extra.length}">${xfsM[2]}${extra.join("")}</cellXfs>`);
  return { variant, finish };
}

async function buildXlsx(rows, highlight) {
  const zip = await JSZip.loadAsync(Buffer.from(TEMPLATE_B64, "base64"));
  const path = "xl/worksheets/sheet2.xml";
  let xml = await zip.file(path).async("string");
  const st = prepareStyles(await zip.file("xl/styles.xml").async("string"));
  const hl = new Set((highlight || []).map(Number));
  const setCell = (ref, row, val, numeric, colorize) => {
    const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
    xml = xml.replace(re, (m, attrs) => {
      let s = (attrs.match(/s="(\d+)"/) || [])[1];
      if (colorize && s != null) s = String(st.variant(Number(s), hl.has(row)));
      const sa = s != null ? `s="${s}"` : "";
      if (val === "" || val == null) return `<c r="${ref}" ${sa}/>`;
      if (numeric) return `<c r="${ref}" ${sa}><v>${Number(val)}</v></c>`;
      return `<c r="${ref}" ${sa} t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
    });
  };
  for (const it of ITEMS) {
    const v = rows?.[it.r] || {};
    const g = (v.g ?? "").toString().trim();
    setCell(`G${it.r}`, it.r, g, g !== "" && !isNaN(Number(g)), false);
    setCell(`I${it.r}`, it.r, (v.i || "").trim(), false, true);
    setCell(`J${it.r}`, it.r, (v.j || "").trim(), false, true);
  }
  zip.file(path, xml);
  zip.file("xl/styles.xml", st.finish());
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function POST(req) {
  if (!(await requireUser(req))) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  if (body.action === "export") {
    const buf = await buildXlsx(body.rows || {}, (body.stage === "S" || body.stage === "P") ? body.highlight : []);
    const name = `${body.company || "업체"}_${STAGE[body.stage] || ""}_평가지표.xlsx`;
    return new Response(buf, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  }

  if (body.action === "review") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return Response.json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다." }, { status: 500 });
    if (!body.transcript || !body.transcript.trim()) return Response.json({ error: "회의록이 없습니다." }, { status: 400 });
    const res = await askClaude(key, reviewPrompt(body), 8000);
    if (res.error) return Response.json(res, { status: 502 });
    const valid = new Set(ITEMS.map(it => it.r));
    const pick = arr => (Array.isArray(arr) ? arr : []).filter(x => x && valid.has(Number(x.r))).map(x => ({ r: Number(x.r), q: String(x.q || "").trim() }));
    const j = res.json || {};
    return Response.json({
      ok: (Array.isArray(j.ok) ? j.ok : []).map(Number).filter(n => valid.has(n)),
      unclear: pick(j.unclear),
      missing: pick(j.missing),
      issues: (Array.isArray(j.issues) ? j.issues : []).map(x => ({ quote: String(x.quote || ""), guess: String(x.guess || ""), q: String(x.q || "") })).filter(x => x.quote || x.q).slice(0, 30),
    });
  }

  if (body.action === "draft") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return Response.json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다." }, { status: 500 });
    const hasChecks = body.checks && body.checks.s && Object.keys(body.checks.s).length > 0;
    if ((!body.transcript || !body.transcript.trim()) && !hasChecks) return Response.json({ error: "회의록과 체크 결과가 모두 없습니다." }, { status: 400 });
    const heights = await rowHeights();
    // 뒤쪽 누락 방지: A~C / D~F 두 번에 나눠 작성
    const groups = [WORK.filter(it => /^[ABC]/.test(it.ind)), WORK.filter(it => /^[DEF]/.test(it.ind))];
    const results = await Promise.all(groups.map(g => askClaude(key, draftPrompt(body, g, heights), 12000)));
    const err = results.find(x => x.error);
    if (err) return Response.json(err, { status: 502 });
    const valid = new Set(WORK.map(it => it.r));
    const rows = {};
    for (const res of results) for (const x of (Array.isArray(res.json?.rows) ? res.json.rows : [])) {
      const rr = Number(x.r);
      if (!valid.has(rr)) continue;
      rows[rr] = { i: String(x.i || "").trim(), j: String(x.j || "").trim(), nb: !!x.nb };
    }
    // 분량 초과 칸만 한 번 더 줄이기
    const over = Object.entries(rows).filter(([r, v]) => overBudget(v.i, budgetOf(heights[r])) || overBudget(v.j, budgetOf(heights[r])))
      .map(([r, v]) => ({ r: Number(r), i: v.i, j: v.j }));
    if (over.length) {
      const sh = await askClaude(key, shrinkPrompt(over, heights), 6000);
      for (const x of (Array.isArray(sh.json?.rows) ? sh.json.rows : [])) {
        const rr = Number(x.r);
        if (rows[rr]) { if (x.i) rows[rr].i = String(x.i).trim(); if (x.j) rows[rr].j = String(x.j).trim(); }
      }
    }
    for (const [r, v] of Object.entries(rows)) {
      const bud = budgetOf(heights[r]);
      v.over = overBudget(v.i, bud) || overBudget(v.j, bud);
    }
    return Response.json({ rows, shrunk: over.length });
  }

  return Response.json({ error: "알 수 없는 요청" }, { status: 400 });
}
