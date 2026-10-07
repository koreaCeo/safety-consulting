import { requireUser } from "../_auth";
export const runtime = "nodejs";
export const maxDuration = 300;

const MIME = { mp3: "audio/mpeg", mp4: "audio/mp4", m4a: "audio/mp4", wav: "audio/wav", webm: "audio/webm", mpga: "audio/mpeg", mpeg: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac" };

// 무음·잡음 구간에서 생기는 지어낸 문장
const JUNK = /(MBC|KBS|SBS|YTN|JTBC)\s*뉴스|뉴스\s*\S+입니다|시청해\s*주셔서|구독(과|,)?\s*좋아요|좋아요(와|,)?\s*구독|자막\s*(제공|by)|다음\s*영상에서|^\s*감사합니다\.?\s*$/;

// 같은 말이 3번 이상 연달아 반복되면 한 번만 남김
function collapseRepeats(t) {
  let s = t;
  for (let i = 0; i < 3; i++) {
    s = s.replace(/(.{2,120}?)(?:[\s,.]*\1){2,}/gs, "$1");
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

async function callOpenAI(key, buf, name, model) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: MIME[ext] || "audio/webm" }), name);
  fd.append("model", model);
  fd.append("language", "ko");
  if (model === "whisper-1") {
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
  } else {
    fd.append("response_format", "json");
  }
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { authorization: "Bearer " + key }, body: fd,
  });
  if (!r.ok) return { ok: false, status: r.status, detail: (await r.text()).slice(0, 300) };
  const d = await r.json();
  let text;
  if (Array.isArray(d.segments)) {
    // 구형 모델: 반복·잡음 구간 버리기
    text = d.segments
      .filter(s => !(s.compression_ratio > 2.4))
      .filter(s => !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.5))
      .map(s => (s.text || "").trim())
      .filter(t => t && !JUNK.test(t))
      .join(" ");
  } else {
    text = (d.text || "").split(/(?<=[.?!])\s+/).filter(t => !JUNK.test(t)).join(" ");
  }
  return { ok: true, text: collapseRepeats(text), model };
}

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
  const name = filename || "audio.webm";

  // 신형 모델 먼저, 실패하면 구형으로
  let res = await callOpenAI(key, buf, name, "gpt-4o-transcribe");
  if (!res.ok) res = await callOpenAI(key, buf, name, "whisper-1");
  if (!res.ok) return Response.json({ error: "음성 변환 오류", detail: res.detail }, { status: 502 });
  return Response.json({ text: res.text, model: res.model });
}
