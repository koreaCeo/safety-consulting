import { requireUser } from "../_auth";
export const runtime = "nodejs";
export const maxDuration = 120;

// 법제처 원문으로 확인된 조문만 사용 (AI는 이 목록의 ID만 고를 수 있음)
const LAWS = {
  R13:  "산업안전보건기준에 관한 규칙 제13조(안전난간의 구조 및 설치요건)",
  R14:  "산업안전보건기준에 관한 규칙 제14조(낙하물에 의한 위험의 방지)",
  R42:  "산업안전보건기준에 관한 규칙 제42조(추락의 방지)",
  R43:  "산업안전보건기준에 관한 규칙 제43조(개구부 등의 방호 조치)",
  R67:  "산업안전보건기준에 관한 규칙 제67조(말비계)",
  R301: "산업안전보건기준에 관한 규칙 제301조(전기 기계·기구 등의 충전부 방호)",
  R302: "산업안전보건기준에 관한 규칙 제302조(전기 기계·기구의 접지)",
  R303: "산업안전보건기준에 관한 규칙 제303조(전기 기계·기구의 적정설치 등)",
  R304: "산업안전보건기준에 관한 규칙 제304조(누전차단기에 의한 감전방지)",
  R305: "산업안전보건기준에 관한 규칙 제305조(과전류 차단장치)",
  R309: "산업안전보건기준에 관한 규칙 제309조(임시로 사용하는 전등 등의 위험 방지)",
  R313: "산업안전보건기준에 관한 규칙 제313조(배선 등의 절연피복 등)",
  R314: "산업안전보건기준에 관한 규칙 제314조(습윤한 장소의 이동전선 등)",
  R315: "산업안전보건기준에 관한 규칙 제315조(통로바닥에서의 전선 등 사용 금지)",
  R316: "산업안전보건기준에 관한 규칙 제316조(꽂음접속기의 설치·사용 시 준수사항)",
  R317: "산업안전보건기준에 관한 규칙 제317조(이동 및 휴대장비 등의 사용 전기 작업)",
  L115: "산업안전보건법 제115조(물질안전보건자료대상물질 용기 등의 경고표시)",
};

const LAW_LIST = Object.entries(LAWS).map(([k, v]) => `${k}: ${v}`).join("\n");

function buildPrompt(note) {
  return `당신은 건설현장 안전점검을 수행하는 산업안전지도사의 보조자입니다.
첨부 사진은 건설현장 지적사항 사진이고, 아래 "전문가 의견"은 지도사가 현장에서 직접 판단해 적은 키워드입니다.

전문가 의견: ${note || "(없음)"}

작성 규칙:
1. 전문가 의견을 판단의 기준으로 삼고, 사진은 보조 근거로만 사용한다. 전문가 의견과 다른 방향으로 해석하지 않는다.
2. 고용노동부·한국산업안전보건공단(KOSHA) 자료에서 쓰는 건설현장 용어와 기술적 표현으로 작성한다. (예: "화학자재"가 아니라 "유해위험물질")
3. 사진이나 전문가 의견으로 확인되지 않는 장치·기능·수치·사실은 지어내지 않는다.
4. 장소는 작성하지 않는다.
5. "현장 확인 필요", "단정하지 않음" 같은 유보 문구는 쓰지 않는다.
6. risk: 한 문장. "~로 인한 ~ 위험" 형태로 위험 원인과 재해 결과를 구체적으로 적는다.
7. measures: 실제 조치 순서대로 3~4개. 각 항목은 짧은 명사형 문장.
8. laws: 아래 목록에서 실제로 해당하는 ID만 고른다. 산업안전보건기준에 관한 규칙(R로 시작)을 먼저 검토하고, 해당 조문이 없을 때만 산업안전보건법(L로 시작)을 고른다. 해당 개수만큼 1~3개, 직접 관련된 것만. 맞는 것이 없으면 빈 배열.

조문 목록:
${LAW_LIST}

JSON 하나로만 답한다. 형식:
{"risk":"","measures":["",""],"laws":["R304"]}`;
}

export async function POST(req) {
  if (!(await requireUser(req))) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다." }, { status: 500 });

  const { url, note } = await req.json().catch(() => ({}));
  if (!url || !url.startsWith(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    return Response.json({ error: "잘못된 사진 주소" }, { status: 400 });
  }
  const img = await fetch(url);
  if (!img.ok) return Response.json({ error: "사진을 가져오지 못했습니다." }, { status: 502 });
  const b64 = Buffer.from(await img.arrayBuffer()).toString("base64");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          { type: "text", text: buildPrompt((note || "").slice(0, 1000)) },
        ],
      }],
    }),
  });
  if (!r.ok) return Response.json({ error: "분석 서버 오류", detail: (await r.text()).slice(0, 300) }, { status: 502 });

  const d = await r.json();
  const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  let out;
  try { out = JSON.parse(m[0]); } catch { return Response.json({ error: "분석 결과를 해석하지 못했습니다." }, { status: 502 }); }

  // 목록에 없는 조문은 버림 → 조문 번호를 지어낼 수 없음
  const ids = Array.isArray(out.laws) ? out.laws.filter(id => LAWS[id]) : [];
  const uniq = [...new Set(ids)].slice(0, 3);
  // 기준규칙이 하나라도 있으면 법(L) 조문은 제외
  const finalIds = uniq.some(id => id.startsWith("R")) ? uniq.filter(id => id.startsWith("R")) : uniq;

  return Response.json({
    risk: String(out.risk || "").trim(),
    measures: (Array.isArray(out.measures) ? out.measures : []).map(s => String(s).trim()).filter(Boolean).slice(0, 5),
    laws: finalIds.map(id => LAWS[id]),
  });
}
