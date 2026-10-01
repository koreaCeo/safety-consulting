export const runtime = "nodejs";

const PROMPT = `첨부한 이미지는 한국 기업의 종이 명함입니다. 적힌 내용만 그대로 읽어서 JSON 하나로만 답하세요.
추측하거나 없는 내용을 지어내지 마세요. 없는 항목은 빈 문자열 또는 빈 배열로 두세요.

형식:
{"company":"","name":"","title":"","dept":"","mobile":"","phone":"","fax":"","address":"","emails":[{"email":"","label":""}],"website":"","confidence":0.0}

규칙:
- company: 법인 형태 표기((주), ㈜ 등)를 명함에 적힌 그대로 포함
- title: 직책(전문위원, 과장, 대표이사 등). 자격증 명칭(산업안전지도사 등)은 title·dept에 넣지 말 것
- mobile: 휴대폰 번호, phone: 일반 전화번호. 하이픈 포함 표기 유지
- emails: 명함에 적힌 모든 메일 주소를 빠짐없이 배열로. label에는 명함에 표기된 구분(일반, 관리, 개인 등), 없으면 빈 문자열
- 비슷하지만 다른 주소(밑줄, 점 하나 차이)가 여러 개면 모두 각각 별도 항목으로
- confidence: 글자를 얼마나 선명하게 읽었는지 0.0~1.0
JSON 외의 설명은 쓰지 마세요.`;

export async function POST(req) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다." }, { status: 500 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "잘못된 요청" }, { status: 400 }); }
  const { image, mediaType } = body || {};
  if (!image || !mediaType) return Response.json({ error: "이미지가 없습니다." }, { status: 400 });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    return Response.json({ error: "인식 서버 오류", detail: t.slice(0, 300) }, { status: 502 });
  }
  const data = await r.json();
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return Response.json({ error: "인식 결과를 해석하지 못했습니다." }, { status: 502 });
  try {
    return Response.json(JSON.parse(m[0]));
  } catch {
    return Response.json({ error: "인식 결과를 해석하지 못했습니다." }, { status: 502 });
  }
}
