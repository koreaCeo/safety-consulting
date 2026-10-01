import { requireUser } from "../_auth";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req) {
  const user = await requireUser(req);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: "OPENAI_API_KEY 가 설정되지 않았습니다." }, { status: 500 });

  const { url, filename } = await req.json().catch(() => ({}));
  if (!url || !url.startsWith(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    return Response.json({ error: "잘못된 파일 주소" }, { status: 400 });
  }
  const a = await fetch(url);
  if (!a.ok) return Response.json({ error: "녹음 파일을 가져오지 못했습니다." }, { status: 502 });
  const buf = await a.arrayBuffer();
  if (buf.byteLength > 25 * 1024 * 1024) return Response.json({ error: "파일이 25MB를 넘습니다." }, { status: 413 });

  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/webm" }), filename || "audio.webm");
  fd.append("model", "whisper-1");
  fd.append("language", "ko");
  fd.append("prompt", "건설현장 안전보건 컨설팅 회의. 위험성평가, 안전보건관리책임자, 관리감독자, TBM, 중대재해, 산업안전보건법.");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { authorization: "Bearer " + key }, body: fd,
  });
  if (!r.ok) {
    const t = await r.text();
    return Response.json({ error: "음성 변환 오류", detail: t.slice(0, 300) }, { status: 502 });
  }
  const d = await r.json();

  // 무음 구간에서 생기는 지어낸 문장 제거
  const JUNK = /(MBC|KBS|SBS|YTN|JTBC)\s*뉴스|뉴스\s*\S+입니다|시청해\s*주셔서|구독(과|,)?\s*좋아요|좋아요(와|,)?\s*구독|자막\s*(제공|by)|다음\s*영상에서|^\s*감사합니다\.?\s*$/;
  const segs = Array.isArray(d.segments) ? d.segments : null;
  let text;
  if (segs) {
    text = segs
      .filter(s => !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.5))
      .map(s => (s.text || "").trim())
      .filter(t => t && !JUNK.test(t))
      .join(" ");
  } else {
    text = (d.text || "").split(/(?<=[.?!])\s+/).filter(t => !JUNK.test(t)).join(" ");
  }
  return Response.json({ text });
}
