import JSZip from "jszip";
import { requireUser } from "../_auth";
import { ITEMS, SAMPLES } from "./items";
import { TEMPLATE_B64 } from "./template";
export const runtime = "nodejs";
export const maxDuration = 300;

const STAGE = { DIAG: "수준진단", I: "I단계", S: "S단계", P: "P단계" };

function draftPrompt({ company, stage, transcript, prev, answers }) {
  const list = ITEMS.map(it => `${it.r} | ${it.ind} | ${it.crit.replace(/\n/g, " ")} | 배점 ${it.max}`).join("\n");
  const sample = SAMPLES.map(s => `[기준] ${s.crit}\n[현황 및 문제점]\n${s.i}\n[개선대책]\n${s.j}`).join("\n\n");
  const prevRows = Object.entries(prev || {}).filter(([, v]) => v && (v.g || v.i || v.j));
  const prevText = prevRows.length
    ? prevRows.map(([r, v]) => `${r}\n현황: ${v.i || "-"}\n개선대책: ${v.j || "-"}`).join("\n\n")
    : "";

  const ans = Array.isArray(answers) ? answers.filter(a => a && a.a && String(a.a).trim()) : [];
  const ansText = ans.map(a => a.r ? `${a.r}행 | 질문: ${a.q} | 지도사 답: ${a.a}` : `회의록 확인 | 원문: "${a.quote}" | 질문: ${a.q} | 지도사 답: ${a.a}`).join("\n");
  const unanswered = Array.isArray(answers) ? answers.filter(a => a && a.r && !(a.a && String(a.a).trim())).map(a => a.r) : [];
  return `당신은 건설업 안전보건관리체계 구축 컨설팅을 수행하는 산업안전지도사의 보조자입니다.
업체: ${company || ""} / 단계: ${STAGE[stage] || stage}
${ansText ? `\n[지도사 확인 답변 — 회의록보다 우선하는 근거. 회의록 오류 정정도 반영할 것]\n${ansText}\n` : ""}${unanswered.length ? `\n[확인되지 않은 기준 — 추측해서 채우지 말 것: ${[...new Set(unanswered)].join(", ")}행]\n` : ""}
아래 "회의 스크립트"(본사·현장 방문 회의를 음성인식한 원문)를 근거로, 평가지표 체크리스트 각 세부기준의 [현황 및 문제점], [개선대책]을 작성합니다. 평가점수는 지도사가 직접 매기므로 작성하지 않습니다.

작성 규칙:
1. 회의 스크립트에 근거가 있는 기준만 작성한다. 근거가 없는 기준은 출력하지 않는다. 없는 내용을 지어내지 않는다.
2. 문체는 아래 "문체 견본"을 그대로 따른다. 줄마다 "- 본사 : …" 또는 "- 현장 : …"(둘 다 해당하면 "- 본사/현장 : …")으로 시작하는 짧은 명사형 문장.
3. 공식 문서 표현을 쓴다. "카카오톡"은 "SNS"로 쓰고, 회의 중 사담·진행상황(메일 보냄 등)은 쓰지 않는다.
5. 음성인식 원문이라 오탈자가 있으니 문맥으로 이해한다.
${prevText ? `6. 아래 "앞 단계 작성 내용"을 기준으로, 이번 회의에서 달라진 기준만 출력한다. 달라진 기준은 앞 단계 문장을 바탕으로 이번에 확인된 개선·변경 사항을 반영해 현황·개선대책을 다시 쓴다. 달라지지 않은 기준은 출력하지 않는다.` : ""}

문체 견본:
${sample}

세부기준 목록 (행번호 | 지표 | 기준 | 배점):
${list}
${prevText ? `\n앞 단계 작성 내용 (행번호 / 현황 / 개선대책):\n${prevText}\n` : ""}
회의 스크립트:
${(transcript || "").slice(0, 150000)}

JSON 하나로만 답한다. 형식:
{"rows":[{"r":5,"i":"- 본사 : …","j":"- 본사 : …"}]}`;
}

function reviewPrompt({ company, stage, visitLabel, location, transcript, prev, prep }) {
  const rel = ITEMS.filter(it => location === "ALL" || it.where === "본사/현장" || it.where === location);
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

async function buildXlsx(rows) {
  const zip = await JSZip.loadAsync(Buffer.from(TEMPLATE_B64, "base64"));
  const path = "xl/worksheets/sheet2.xml";
  let xml = await zip.file(path).async("string");
  const setCell = (ref, val, numeric) => {
    const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
    xml = xml.replace(re, (m, attrs) => {
      const s = (attrs.match(/s="\d+"/) || [""])[0];
      if (val === "" || val == null) return `<c r="${ref}" ${s}/>`;
      if (numeric) return `<c r="${ref}" ${s}><v>${Number(val)}</v></c>`;
      return `<c r="${ref}" ${s} t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
    });
  };
  for (const it of ITEMS) {
    const v = rows?.[it.r] || {};
    const g = (v.g ?? "").toString().trim();
    setCell(`G${it.r}`, g, g !== "" && !isNaN(Number(g)));
    setCell(`I${it.r}`, (v.i || "").trim(), false);
    setCell(`J${it.r}`, (v.j || "").trim(), false);
  }
  zip.file(path, xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function POST(req) {
  if (!(await requireUser(req))) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  if (body.action === "export") {
    const buf = await buildXlsx(body.rows || {});
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
    if (!body.transcript || !body.transcript.trim()) return Response.json({ error: "회의 스크립트가 없습니다." }, { status: 400 });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16000,
        messages: [{ role: "user", content: draftPrompt(body) }],
      }),
    });
    if (!r.ok) return Response.json({ error: "AI 서버 오류", detail: (await r.text()).slice(0, 300) }, { status: 502 });
    const d = await r.json();
    const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    let out;
    try { out = JSON.parse(m[0]); } catch { return Response.json({ error: "AI 결과를 해석하지 못했습니다." }, { status: 502 }); }
    const valid = new Set(ITEMS.map(it => it.r));
    const rows = {};
    for (const x of Array.isArray(out.rows) ? out.rows : []) {
      const rr = Number(x.r);
      if (!valid.has(rr)) continue;
      rows[rr] = { i: String(x.i || "").trim(), j: String(x.j || "").trim() };
    }
    return Response.json({ rows });
  }

  return Response.json({ error: "알 수 없는 요청" }, { status: 400 });
}
