"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import Record from "./Record";
import Photos from "./Photos";

const APP_VERSION = "v11";
let _c = null;
function sb() {
  if (!_c) _c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { lock: async (_name, _timeout, fn) => await fn() },
  });
  return _c;
}
function normName(s) {
  return (s || "").toLowerCase().replace(/\s|\(주\)|㈜|주식회사|\(유\)|유한회사/g, "");
}

const ROLES = [
  ["staff", "업무담당자"], ["ceo", "대표이사"], ["site_manager", "현장소장"],
  ["safety_officer", "안전보건담당자"], ["other", "기타"],
];

function guessRole(t) {
  if (/대표이사|대표$|사장|회장/.test(t)) return "ceo";
  if (/소장/.test(t)) return "site_manager";
  if (/안전|보건/.test(t)) return "safety_officer";
  return "staff";
}

function withTimeout(p, ms = 15000) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("응답 없음 (15초). 새로고침 후 다시 시도하세요.")), ms))]);
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function shrink(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(b => res(b), "image/jpeg", 0.88));
}

export default function Page() {
  const [session, setSession] = useState(undefined);
  const [bootErr, setBootErr] = useState("");
  useEffect(() => {
    let done = false;
    const t = setTimeout(() => { if (!done) setBootErr("세션 확인이 10초 넘게 걸립니다. 다른 탭을 모두 닫고 새로고침해 보세요."); }, 10000);
    sb().auth.getSession().then(({ data }) => { done = true; clearTimeout(t); setSession(data.session); })
      .catch(e => { done = true; clearTimeout(t); setBootErr("세션 오류: " + (e.message || "")); });
    const { data: sub } = sb().auth.onAuthStateChange((_e, s) => { setTimeout(() => setSession(s), 0); });
    return () => { clearTimeout(t); sub.subscription.unsubscribe(); };
  }, []);
  if (session === undefined) return (
    <div className="wrap">
      <div className="sub">{APP_VERSION}</div>
      {bootErr ? <div className="msg err">{bootErr}</div> : <div className="empty">세션 확인 중…</div>}
    </div>
  );
  if (!session) return <Login />;
  return <Main onLogout={() => sb().auth.signOut()} />;
}

function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault();
    setBusy(true); setMsg("");
    const { error } = await sb().auth.signInWithPassword({ email, password: pw });
    if (error) setMsg("로그인 실패: 이메일 또는 비밀번호를 확인하세요.");
    setBusy(false);
  }
  return (
    <div className="wrap">
      <div className="card login">
        <h2>안전컨설팅 자동화 로그인</h2>
        <form onSubmit={go}>
          <label>이메일</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
          <label>비밀번호</label>
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} required />
          <div className="actions">
            <button className="btn primary" disabled={busy}>로그인</button>
          </div>
          {msg && <div className="msg err">{msg}</div>}
        </form>
      </div>
    </div>
  );
}

function Main({ onLogout }) {
  const [tab, setTab] = useState("scan");
  return (
    <div className="wrap">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h1>안전상생 컨설팅</h1>
          <div className="sub">안전상생 컨설팅 자동화 · 1단계 · {APP_VERSION}</div>
        </div>
        <button className="btn sm" onClick={onLogout}>로그아웃</button>
      </div>
      <div className="tabs">
        <button className={"tab" + (tab === "scan" ? " on" : "")} onClick={() => setTab("scan")}>명함 등록</button>
        <button className={"tab" + (tab === "list" ? " on" : "")} onClick={() => setTab("list")}>업체 목록</button>
        <button className={"tab" + (tab === "rec" ? " on" : "")} onClick={() => setTab("rec")}>회의 녹음</button>
        <button className={"tab" + (tab === "photo" ? " on" : "")} onClick={() => setTab("photo")}>현장 사진</button>
      </div>
      {tab === "scan" ? <Scan /> : tab === "list" ? <List /> : tab === "rec" ? <Record sb={sb()} /> : <Photos sb={sb()} />}
    </div>
  );
}

const EMPTY = { company: "", name: "", title: "", dept: "", role: "staff", mobile: "", phone: "", address: "" };

function Scan() {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState(null);
  const [mails, setMails] = useState([]);
  const [newMail, setNewMail] = useState("");
  const [conf, setConf] = useState(null);
  const [dup, setDup] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  function pick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setPreview(URL.createObjectURL(f)); setMsg(null);
  }
  function reset() {
    setFile(null); setPreview(""); setForm(null); setMsg(null); setSaveMsg(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function read() {
    if (!file) return;
    setBusy(true); setMsg({ t: "info", s: "명함을 읽는 중입니다… (5~15초)" });
    try {
      const blob = await shrink(file);
      const image = await fileToBase64(blob);
      const { data: ss } = await sb().auth.getSession();
      const r = await fetch("/api/ocr", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + (ss.session?.access_token || "") },
        body: JSON.stringify({ image, mediaType: "image/jpeg" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "인식 실패");
      fill(d); setMsg(null);
    } catch (e) {
      setMsg({ t: "err", s: (e.message || "명함을 읽지 못했습니다.") + " 직접 입력할 수 있습니다." });
      fill({});
    } finally { setBusy(false); }
  }

  function fill(d) {
    setForm({
      company: d.company || "", name: d.name || "", title: d.title || "", dept: d.dept || "",
      role: guessRole(d.title || ""), mobile: d.mobile || "", phone: d.phone || "", address: d.address || "",
    });
    const arr = Array.isArray(d.emails) ? d.emails : [];
    const ms = [];
    for (const x of arr) {
      const em = (x?.email || "").trim();
      if (em) ms.push({ email: em, label: (x.label || "").trim(), def: ms.length === 0 });
    }
    setMails(ms);
    setConf(typeof d.confidence === "number" ? d.confidence : null);
    setSaveMsg(null);
    checkDup(d.company || "");
  }

  async function checkDup(name) {
    const n = normName(name);
    if (!n) { setDup(false); return; }
    const { data } = await sb().from("companies").select("id").eq("name_normalized", n).is("deleted_at", null).limit(1);
    setDup(!!(data && data.length));
  }

  function addMail() {
    const v = newMail.trim();
    if (!v) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setSaveMsg({ t: "err", s: "메일 주소 형식이 올바르지 않습니다." }); return; }
    if (mails.some(m => m.email.toLowerCase() === v.toLowerCase())) { setSaveMsg({ t: "err", s: "이미 있는 메일 주소입니다." }); return; }
    setMails([...mails, { email: v, label: "", def: mails.length === 0 }]);
    setNewMail(""); setSaveMsg(null);
  }

  async function save() {
    const company = form.company.trim(), name = form.name.trim();
    if (!company) { setSaveMsg({ t: "err", s: "업체명을 입력해 주세요." }); return; }
    if (!name) { setSaveMsg({ t: "err", s: "담당자 이름을 입력해 주세요." }); return; }
    setBusy(true); setSaveMsg({ t: "info", s: "저장 중…" });
    try {
      const n = normName(company);
      let { data: found } = await sb().from("companies").select("id").eq("name_normalized", n).is("deleted_at", null).limit(1);
      let companyId = found?.[0]?.id;
      if (!companyId) {
        const { data, error } = await sb().from("companies").insert({ name: company, address: form.address || null }).select("id").single();
        if (error) throw error;
        companyId = data.id;
      }
      const { data: ct, error: e2 } = await sb().from("contacts").insert({
        company_id: companyId, name, dept: form.dept || null, title: form.title || null,
        phone: form.mobile || form.phone || null, email: mails.find(m => m.def)?.email || null,
        role: form.role, source: "card", ocr_confidence: conf, is_primary: !found?.length,
      }).select("id").single();
      if (e2) throw e2;
      if (mails.length) {
        const { error: e3 } = await sb().from("contact_emails").insert(
          mails.map(m => ({ contact_id: ct.id, email: m.email, label: m.label || null, is_default: !!m.def }))
        );
        if (e3) throw e3;
      }
      setSaveMsg({ t: "info", s: `저장했습니다 — ${company} / ${name}` });
      setTimeout(reset, 1400);
    } catch (e) {
      setSaveMsg({ t: "err", s: "저장 실패: " + (e.message || "") });
    } finally { setBusy(false); }
  }

  const set = k => e => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <div className="card">
        <h2>1. 명함 촬영</h2>
        <label className="shoot" htmlFor="file">
          <strong>명함 찍기 / 사진 고르기</strong>
          <small>폰에서는 카메라가 바로 열립니다</small>
          {preview && <img src={preview} alt="명함 미리보기" />}
        </label>
        <input ref={fileRef} id="file" type="file" accept="image/*" capture="environment" className="hidden" onChange={pick} />
        <div className="actions">
          <button className="btn primary" disabled={!file || busy} onClick={read}>명함 읽기</button>
          <button className="btn" onClick={reset}>다시 선택</button>
          <button className="btn" onClick={() => fill({})}>직접 입력</button>
        </div>
        {msg && <div className={"msg " + msg.t}>{msg.s}</div>}
      </div>

      {form && (
        <div className="card">
          <h2>2. 인식 결과 확인</h2>
          <div className="msg info">인식 결과가 맞는지 확인하고 고쳐주세요. 저장은 확인 후에 됩니다.</div>

          <label>업체명</label>
          <input value={form.company} onChange={e => { set("company")(e); checkDup(e.target.value); }} />
          {dup && <div className="msg warn">이미 등록된 업체명입니다. 저장하면 담당자가 추가됩니다.</div>}

          <div className="row">
            <div><label>이름</label><input value={form.name} onChange={set("name")} /></div>
            <div><label>직책</label><input value={form.title} onChange={set("title")} /></div>
          </div>
          <div className="row">
            <div><label>부서</label><input value={form.dept} onChange={set("dept")} /></div>
            <div><label>구분</label>
              <select value={form.role} onChange={set("role")}>
                {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="row">
            <div><label>휴대폰</label><input type="tel" value={form.mobile} onChange={set("mobile")} /></div>
            <div><label>전화</label><input type="tel" value={form.phone} onChange={set("phone")} /></div>
          </div>

          <label>메일 주소 — 기본 수신자를 선택하세요</label>
          <div>
            {mails.length === 0 && <div className="conf">인식된 메일 주소가 없습니다. 아래에서 추가해 주세요.</div>}
            {mails.map((m, i) => (
              <div className="mailrow" key={m.email}>
                <input type="radio" name="def" checked={!!m.def}
                  onChange={() => setMails(mails.map((x, j) => ({ ...x, def: i === j })))} />
                <span className="m">{m.email}</span>
                {m.label && <span className="lb">{m.label}</span>}
                <button type="button" className="btn sm danger" onClick={() => {
                  const rest = mails.filter((_, j) => j !== i);
                  if (m.def && rest.length) rest[0].def = true;
                  setMails(rest);
                }}>삭제</button>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <div><input type="email" placeholder="메일 직접 추가" value={newMail} onChange={e => setNewMail(e.target.value)} /></div>
            <div style={{ flex: "0 0 auto" }}><button type="button" className="btn sm" style={{ marginTop: 2 }} onClick={addMail}>추가</button></div>
          </div>

          <label>주소</label>
          <textarea value={form.address} onChange={set("address")} />

          {conf !== null && (
            <div className={"conf" + (conf < 0.75 ? " low" : "")}>
              인식 신뢰도 {Math.round(conf * 100)}%{conf < 0.75 ? " — 숫자와 메일 주소를 특히 꼼꼼히 확인하세요." : ""}
            </div>
          )}

          <div className="actions">
            <button className="btn primary" disabled={busy} onClick={save}>저장</button>
            <button className="btn" onClick={() => setForm(null)}>취소</button>
          </div>
          {saveMsg && <div className={"msg " + saveMsg.t}>{saveMsg.s}</div>}
        </div>
      )}
    </>
  );
}

function List() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState("");

  async function load() {
    try {
      const c = await withTimeout(sb().from("companies").select("id, name").is("deleted_at", null).order("name"));
      if (c.error) throw c.error;
      const ct = await withTimeout(sb().from("contacts").select("id, company_id, name, title, dept, phone, is_active").is("deleted_at", null));
      if (ct.error) throw ct.error;
      const em = await withTimeout(sb().from("contact_emails").select("contact_id, email, is_default"));
      if (em.error) throw em.error;
      const mailsOf = {};
      for (const m of em.data || []) (mailsOf[m.contact_id] = mailsOf[m.contact_id] || []).push(m);
      const byCo = {};
      for (const p of ct.data || []) if (p.is_active) {
        const ms = mailsOf[p.id] || [];
        (byCo[p.company_id] = byCo[p.company_id] || []).push({
          ...p, email: (ms.find(m => m.is_default) || ms[0] || {}).email || "", allMails: ms.map(m => m.email),
        });
      }
      setRows((c.data || []).map(x => ({ ...x, contacts: byCo[x.id] || [] })));
      setErr("");
    } catch (e) {
      setErr(e.message || "불러오기 실패"); setRows([]);
    }
  }
  useEffect(() => { load(); }, []);

  async function removeContact(p, coName) {
    if (!confirm(`${coName} · ${p.name} 담당자를 삭제할까요?`)) return;
    setBusyId(p.id);
    const { error } = await sb().from("contacts")
      .update({ is_active: false, is_primary: false, deleted_at: new Date().toISOString() }).eq("id", p.id);
    setBusyId("");
    if (error) { alert("삭제 실패: " + error.message); return; }
    setRows(rs => rs.map(c => ({ ...c, contacts: c.contacts.filter(x => x.id !== p.id) })));
  }

  if (rows === null) return <div className="card"><div className="empty">목록 불러오는 중… (최대 15초)</div></div>;
  if (err) return <div className="card"><div className="msg err">목록 오류: {err}</div></div>;

  const key = q.trim().toLowerCase().replace(/[\s-]/g, "");
  const match = v => (v || "").toLowerCase().replace(/[\s-]/g, "").includes(key);
  const shown = !key ? rows : rows
    .map(c => {
      if (match(c.name)) return c;
      const hit = c.contacts.filter(p => match(p.name) || match(p.phone) || match(p.title) || match(p.dept) || p.allMails.some(match));
      return hit.length ? { ...c, contacts: hit } : null;
    })
    .filter(Boolean);

  return (
    <div className="card">
      <h2>등록된 업체 ({rows.length}) <span className="conf">v11</span></h2>
      <input placeholder="업체명, 담당자 이름, 전화번호, 메일로 검색" value={q} onChange={e => setQ(e.target.value)} />
      {!rows.length && <div className="empty">아직 등록된 업체가 없습니다.</div>}
      {rows.length > 0 && !shown.length && <div className="empty">검색 결과가 없습니다.</div>}
      <div style={{ marginTop: 12 }}>
        {shown.map(c => (
          <div className="item" key={c.id}>
            <div className="nm">{c.name}</div>
            {c.contacts.length === 0 && <div className="de">등록된 담당자 없음</div>}
            {c.contacts.map(p => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <div className="de" style={{ flex: 1, marginTop: 0 }}>
                  {[p.name, p.title, p.phone, p.email].filter(Boolean).join(" · ")}
                </div>
                <button className="btn sm danger" disabled={busyId === p.id} onClick={() => removeContact(p, c.name)}>삭제</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
