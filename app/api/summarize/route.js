import { requireUser } from "../_auth";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req) {
  const user = await requireUser(req);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다." }, { status: 500 });

  const { text, company, stage } = await req.json().catch(() => ({}));
  if (!text || !text.trim()) return Response.json({ error: "요약할 내용이 없습니다." }, { status: 400 });

  const prompt = `아래는 건설업 안전보건 컨설팅 방문 회의를 음성인식한 원문입니다.
업체: ${company || ""} / 단계: ${stage || ""}
음성인식이라 오탈자가 있을 수 있으니 문맥으로 이해하되, 원문에 없는 내용은 지어내지 마세요.

JSON 하나로만 답하세요. 형식:
{"overview":"회의 전체를 3~5문장으로","status_issues":["현황 및 문제점"],"improvements":["개선이 필요하다고 논의된 사항"],"requests_to_company":["업체가 제출·조치하기로 한 것"],"next_check":["다음 방문 때 확인할 것"],"photo_points":["사진 촬영이 필요해 보이는 대상"]}
각 배열 항목은 한 문장. 해당 내용이 없으면 빈 배열.

원문:
${text.slice(0, 180000)}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return Response.json({ error: "요약 서버 오류", detail: (await r.text()).slice(0, 300) }, { status: 502 });
  const d = await r.json();
  const out = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  const m = out.match(/\{[\s\S]*\}/);
  try { return Response.json(JSON.parse(m[0])); }
  catch { return Response.json({ error: "요약 결과를 해석하지 못했습니다." }, { status: 502 }); }
}
