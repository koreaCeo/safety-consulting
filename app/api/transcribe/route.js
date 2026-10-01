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

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { authorization: "Bearer " + key }, body: fd,
  });
  if (!r.ok) {
    const t = await r.text();
    return Response.json({ error: "음성 변환 오류", detail: t.slice(0, 300) }, { status: 502 });
  }
  const d = await r.json();
  return Response.json({ text: d.text || "" });
}
