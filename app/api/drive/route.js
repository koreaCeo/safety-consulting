export const runtime = "nodejs";
export const maxDuration = 60;
import crypto from "crypto";
import { requireUser } from "../_auth";

// 구글 드라이브 단계별 폴더에서 업체 최종본(평가지표 엑셀·결과보고서 한글)을 찾아 가져옴
// Vercel 환경변수: GOOGLE_SERVICE_ACCOUNT (서비스 계정 키 JSON 전체)
// 폴더: 안전보건관리체계구축사업컨설팅 > (I)/(S)/(P)단계 컨설팅 진행 (하위 폴더 '1차' 등은 제외)
const FOLDERS = {
  I: process.env.DRIVE_FOLDER_I || "12h53_X5d5UBoHyisaGmBFTLY32pUavcC",
  S: process.env.DRIVE_FOLDER_S || "1jZxDkTXP_C_o3jIFv0L_OXQyWHsTUMsD",
  P: process.env.DRIVE_FOLDER_P || "1NSZTv0JM9MnKgVcxY9W9_Z9pmWWD0hRV",
};
const API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, "")
    .replace(/[\s_\-.·,()[\]{}]/g, "");
}
function kindOf(name) {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  return ext === "xlsx" ? "xlsx" : (ext === "hwpx" || ext === "hwp") ? "hwpx" : null;
}
// files: [{ id, name, modifiedTime, size, _folder }] → { I: { xlsx, hwpx }, S: …, P: … } (업체명이 들어간 가장 최근 파일)
function pick(files, companyName) {
  const key = norm(companyName);
  const out = { I: {}, S: {}, P: {} };
  if (!key) return out;
  for (const f of files) {
    const kind = kindOf(f.name);
    if (!kind || !norm(f.name).includes(key)) continue;
    const st = f._folder; // 단계는 들어 있는 폴더로 판단
    if (!out[st]) continue;
    const cur = out[st][kind];
    if (!cur || f.modifiedTime > cur.modifiedTime) out[st][kind] = { id: f.id, name: f.name, modifiedTime: f.modifiedTime, size: Number(f.size || 0) };
  }
  return out;
}

let _tok = { v: "", exp: 0 };
async function gToken() {
  if (_tok.v && Date.now() < _tok.exp - 60000) return _tok.v;
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const key = String(sa.private_key || "").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("구글 인증 실패: " + (j.error_description || j.error || r.status));
  _tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return _tok.v;
}

async function gGet(url, tok) {
  const r = await fetch(url, { headers: { authorization: "Bearer " + tok } });
  if (!r.ok) {
    let m = ""; try { m = (await r.json()).error?.message || ""; } catch {}
    throw new Error(`드라이브 읽기 실패 (${r.status}) ${m}`.trim());
  }
  return r;
}

async function listFolder(id, tok) {
  const files = [];
  let page = "";
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`);
    const r = await gGet(`${API}?q=${q}&fields=nextPageToken,files(id,name,modifiedTime,size)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${page ? "&pageToken=" + page : ""}`, tok);
    const j = await r.json();
    files.push(...(j.files || []));
    page = j.nextPageToken || "";
  } while (page);
  return files;
}

// 가져올 파일이 지정 폴더 바로 아래에 있는지 확인하고 내용 받기
async function fetchFile(id, tok) {
  const meta = await (await gGet(`${API}/${encodeURIComponent(id)}?fields=id,name,parents,size&supportsAllDrives=true`, tok)).json();
  if (!(meta.parents || []).some(p => Object.values(FOLDERS).includes(p))) throw new Error("지정된 드라이브 폴더의 파일이 아닙니다.");
  const r = await gGet(`${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, tok);
  return { meta, buf: Buffer.from(await r.arrayBuffer()) };
}

export async function POST(req) {
  const user = await requireUser(req);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) return Response.json({ configured: false });
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "잘못된 요청" }, { status: 400 }); }

  try {
    const tok = await gToken();

    // 1) 업체 최종본 찾기
    if (b.action === "list") {
      const all = [];
      for (const [st, id] of Object.entries(FOLDERS)) for (const f of await listFolder(id, tok)) all.push({ ...f, _folder: st });
      return Response.json({ configured: true, files: pick(all, b.name) });
    }

    // 2) 평가지표 엑셀: 내용을 그대로 돌려줌 (브라우저에서 읽어 저장)
    if (b.action === "get") {
      const { meta, buf } = await fetchFile(String(b.id || ""), tok);
      if (kindOf(meta.name) !== "xlsx") throw new Error("엑셀 파일이 아닙니다.");
      if (buf.length > 4 * 1024 * 1024) throw new Error("엑셀 파일이 너무 큽니다(4MB 이하).");
      return new Response(buf, { headers: { "content-type": "application/octet-stream" } });
    }

    // 3) 결과보고서 한글: 크기가 커서 서버에서 바로 프로그램 저장소에 보관
    if (b.action === "save") {
      const st = String(b.stage || "");
      const companyId = String(b.companyId || "");
      if (!FOLDERS[st] || !/^[0-9a-f-]{36}$/i.test(companyId)) throw new Error("업체·단계 정보가 올바르지 않습니다.");
      const { meta, buf } = await fetchFile(String(b.id || ""), tok);
      if (kindOf(meta.name) !== "hwpx") throw new Error("한글 파일이 아닙니다.");
      const ext = meta.name.split(".").pop().toLowerCase();
      const path = `${user.id}/finals/${companyId}/${st}_report.${ext}`;
      const token = (req.headers.get("authorization") || "").slice(7);
      const up = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/photos/${path.split("/").map(encodeURIComponent).join("/")}`, {
        method: "POST",
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: "Bearer " + token, "x-upsert": "true", "content-type": "application/octet-stream" },
        body: buf,
      });
      if (!up.ok) { let m = ""; try { m = (await up.json()).message || ""; } catch {} throw new Error("프로그램 저장소 보관 실패: " + (m || up.status)); }
      return Response.json({ ok: true, path, name: meta.name });
    }

    return Response.json({ error: "알 수 없는 요청" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e.message || e).slice(0, 300) }, { status: 502 });
  }
}
