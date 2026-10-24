export const runtime = "nodejs";
export const maxDuration = 60;
import nodemailer from "nodemailer";
import { requireUser } from "../_auth";

// 사장님 Gmail로 메일 발송 (Vercel 환경변수: GMAIL_USER, GMAIL_APP_PASSWORD)
export async function POST(req) {
  if (!(await requireUser(req))) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const user = process.env.GMAIL_USER, pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s/g, "");
  if (!user || !pass) return Response.json({ error: "Vercel에 GMAIL_USER, GMAIL_APP_PASSWORD 설정이 필요합니다." }, { status: 500 });
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "잘못된 요청" }, { status: 400 }); }
  const to = String(b.to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return Response.json({ error: "받는 사람 메일 주소가 올바르지 않습니다." }, { status: 400 });
  if (!String(b.subject || "").trim()) return Response.json({ error: "제목이 비어 있습니다." }, { status: 400 });
  const attachments = [];
  if (b.attach?.base64) {
    const buf = Buffer.from(b.attach.base64, "base64");
    if (buf.length > 4 * 1024 * 1024) return Response.json({ error: "첨부 파일이 너무 큽니다(4MB 이하)." }, { status: 400 });
    attachments.push({ filename: String(b.attach.name || "첨부파일"), content: buf });
  }
  try {
    const t = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    await t.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || "신은철"}" <${user}>`,
      to, subject: String(b.subject), text: String(b.text || ""), attachments,
    });
    return Response.json({ ok: true });
  } catch (e) {
    const m = String(e.message || "");
    const hint = /Invalid login|Username and Password not accepted|535/.test(m) ? " (Gmail 앱 비밀번호를 확인하세요)" : "";
    return Response.json({ error: "메일 발송 실패" + hint, detail: m.slice(0, 200) }, { status: 502 });
  }
}
