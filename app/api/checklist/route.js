import JSZip from "jszip";
import { requireUser } from "../_auth";
import { ITEMS, SAMPLES } from "./items";
import { TEMPLATE_B64 } from "./template";
export const runtime = "nodejs";
export const maxDuration = 300;

const STAGE = { DIAG: "수준진단", I: "I단계", S: "S단계", P: "P단계" };

function draftPrompt({ company, stage, transcript, prev }) {
  const list = ITEMS.map(it => `${it.r} | ${it.ind} | ${it.crit.replace(/\n/g, " ")} | 배점 ${it.max}`).join("\n");
  const sample = SAMPLES.map(s => `[기준] ${s.crit}\n[현황 및 문제점]\n${s.i}\n[개선대책]\n${s.j}`).join("\n\n");
  const prevRows = Object.entries(prev || {}).filter(([, v]) => v && (v.g || v.i || v.j));
  const prevText = prevRows.length
    ? prevRows.map(([r, v]) => `${r}\n현황: ${v.i || "-"}\n개선대책: ${v.j || "-"}`).join("\n\n")
    : "";

  return `당신은 건설업 안전보건관리체계 구축 컨설팅을 수행하는 산업안전지도사의 보조자입니다.
업체: ${company || ""} / 단계: ${STAGE[stage] || stage}

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
