"use client";
import { useEffect, useRef, useState } from "react";

const STAGES = [["DIAG", "수준진단"], ["I", "I단계"], ["S", "S단계"], ["P", "P단계"]];
const ROUNDS = { DIAG: [0], I: [1, 2], S: [3], P: [4, 5] };
const SEG_MS = 10 * 60 * 1000; // 10분마다 파일 분할 (변환 용량 제한 대비)

/* ---------- 노트북 내부 임시 보관 (인터넷 끊김 대비) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("consult-rec", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pending", { keyPath: "key" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("pending", "readwrite");
    t.objectStore("pending").put(v);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}
async function idbAll() {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction("pending").objectStore("pending").getAll();
    q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
  });
}
async function idbDel(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("pending", "readwrite");
    t.objectStore("pending").delete(key);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

function fmt(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm"]) if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  return "";
}

export default function Record({ sb }) {
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [stage, setStage] = useState("DIAG");
  const [round, setRound] = useState(0);
  const [loc, setLoc] = useState("HQ");
  const [siteName, setSiteName] = useState("");
  const [visit, setVisit] = useState(null);
  const [msg, setMsg] = useState(null);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [rows, setRows] = useState([]);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState("");
  const [upMsg, setUpMsg] = useState(null);
  const [pasteText, setPasteText] = useState("");
  const textIn = useRef(null);

  const streamRef = useRef(null), recRef = useRef(null), segTimer = useRef(null), tick = useRef(null);
  const seqRef = useRef(1), wakeRef = useRef(null), stopping = useRef(false), visitRef = useRef(null);

  async function token() {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token || "";
  }

  useEffect(() => {
    (async () => {
      const { data } = await sb.from("companies").select("id, name").is("deleted_at", null).order("name");
      setCompanies(data || []);
      setPending((await idbAll()).length);
    })();
    const on = () => uploadPending();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setRound(ROUNDS[stage][0]); if (stage === "DIAG" || stage === "S") setLoc(stage === "S" ? "HQ" : loc); }, [stage]); // eslint-disable-line

  /* ---------- 방문 회차 열기 ---------- */
  async function openVisit() {
    if (!companyId) { setMsg({ t: "err", s: "업체를 선택하세요." }); return; }
    if (loc === "SITE" && !siteName.trim()) { setMsg({ t: "err", s: "현장명을 입력하세요." }); return; }
    setBusy("visit"); setMsg(null);
    try {
      let siteId = null;
      if (loc === "SITE") {
        const { data: cur } = await sb.from("sites").select("id, name").eq("company_id", companyId).eq("is_current", true).is("deleted_at", null).limit(1);
        if (cur?.[0] && cur[0].name === siteName.trim()) siteId = cur[0].id;
        else {
          if (cur?.[0]) await sb.from("sites").update({ is_current: false }).eq("id", cur[0].id);
          const { data, error } = await sb.from("sites").insert({ company_id: companyId, name: siteName.trim(), is_current: true }).select("id").single();
          if (error) throw error;
          siteId = data.id;
        }
      }
      let { data: v } = await sb.from("visits").select("*").eq("company_id", companyId).eq("stage", stage).eq("round_no", round).is("deleted_at", null).limit(1);
      let vv = v?.[0];
      if (!vv) {
        const { data, error } = await sb.from("visits").insert({
          company_id: companyId, stage, round_no: round, location_type: loc, site_id: siteId,
          actual_date: new Date().toISOString().slice(0, 10), status: "in_progress",
        }).select("*").single();
        if (error) throw error;
        vv = data;
      }
      setVisit(vv); visitRef.current = vv;
      await loadRows(vv.id);
    } catch (e) {
      setMsg({ t: "err", s: "방문 회차를 열지 못했습니다: " + (e.message || "") });
    } finally { setBusy(""); }
  }

  async function loadRows(visitId) {
    const { data } = await sb.from("recordings").select("*").eq("visit_id", visitId).order("seq");
    setRows(data || []);
    const max = Math.max(0, ...(data || []).map(r => r.seq));
    const loc = (await idbAll()).filter(p => p.visitId === visitId).map(p => p.seq);
    seqRef.current = Math.max(max, ...loc, 0) + 1;
  }

  /* ---------- 녹음 ---------- */
  function startSegment() {
    const mime = pickMime();
    const rec = new MediaRecorder(streamRef.current, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
    const chunks = [];
    const seq = seqRef.current++;
    const started = Date.now();
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: mime || "audio/webm" });
      const item = { key: visitRef.current.id + "_" + seq, visitId: visitRef.current.id, seq, blob, sec: Math.round((Date.now() - started) / 1000) };
      await idbPut(item);
      setPending((await idbAll()).length);
      uploadOne(item);
      if (!stopping.current) startSegment();
    };
    rec.start(5000);
    recRef.current = rec;
  }

  async function startRec() {
    if (!visit) return;
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setMsg({ t: "err", s: "마이크 사용을 허용해 주세요." }); return;
    }
    try { wakeRef.current = await navigator.wakeLock?.request("screen"); } catch {}
    stopping.current = false;
    setElapsed(0); setRecording(true); setMsg(null);
    startSegment();
    segTimer.current = setInterval(() => recRef.current?.state === "recording" && recRef.current.stop(), SEG_MS);
    tick.current = setInterval(() => setElapsed(x => x + 1), 1000);
  }

  function stopRec() {
    stopping.current = true;
    clearInterval(segTimer.current); clearInterval(tick.current);
    if (recRef.current?.state === "recording") recRef.current.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    try { wakeRef.current?.release(); } catch {}
    setRecording(false);
  }

  /* ---------- 업로드 → 텍스트 변환 ---------- */
  async function uploadOne(item) {
    if (!navigator.onLine) return;
    try {
      const { data: u } = await sb.auth.getUser();
      const path = `${u.user.id}/${item.visitId}/${item.seq}.webm`;
      const up = await sb.storage.from("recordings").upload(path, item.blob, { upsert: true, contentType: "audio/webm" });
      if (up.error) throw up.error;
      const { data: row, error } = await sb.from("recordings").upsert({
        visit_id: item.visitId, seq: item.seq, storage_path: path, duration_sec: item.sec,
        file_size: item.blob.size, upload_status: "done", transcript_status: "pending",
      }, { onConflict: "visit_id,seq" }).select("*").single();
      if (error) throw error;
      await idbDel(item.key);
      setPending((await idbAll()).length);
      if (visitRef.current?.id === item.visitId) await loadRows(item.visitId);
      transcribe(row);
    } catch (e) {
      setMsg({ t: "warn", s: "업로드 대기 중 (인터넷 연결 후 자동 재시도): " + (e.message || "") });
    }
  }

  async function uploadPending() {
    const all = await idbAll();
    for (const it of all) await uploadOne(it);
  }

  async function transcribe(row) {
    await sb.from("recordings").update({ transcript_status: "processing", error_message: null }).eq("id", row.id);
    if (visitRef.current?.id === row.visit_id) await loadRows(row.visit_id);
    try {
      const { data: s, error } = await sb.storage.from("recordings").createSignedUrl(row.storage_path, 900);
      if (error) throw error;
      const r = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (await token()) },
        body: JSON.stringify({ url: s.signedUrl, filename: row.storage_path.split("/").pop() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error + (d.detail ? " " + d.detail : ""));
      await sb.from("recordings").update({ transcript_text: d.text, transcript_status: "done" }).eq("id", row.id);
    } catch (e) {
      await sb.from("recordings").update({ transcript_status: "failed", error_message: String(e.message || e).slice(0, 300) }).eq("id", row.id);
    }
    if (visitRef.current?.id === row.visit_id) await loadRows(row.visit_id);
  }

  /* ---------- 회의 자료 올리기 (음성 파일 / 텍스트) ---------- */
  async function saveText(text, label) {
    const t = (text || "").replace(/^\ufeff/, "").trim();
    if (!t) { setUpMsg({ t: "err", s: "내용이 비어 있습니다." }); return; }
    const seq = seqRef.current++;
    const { error } = await sb.from("recordings").upsert({
      visit_id: visit.id, seq, storage_path: null, local_path: label, duration_sec: 0,
      upload_status: "done", transcript_status: "done", transcript_text: t,
    }, { onConflict: "visit_id,seq" });
    if (error) { setUpMsg({ t: "err", s: "저장 실패: " + error.message }); return; }
    setUpMsg({ t: "info", s: "텍스트를 추가했습니다." });
    await loadRows(visit.id);
  }

  async function onTextFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !visit) return;
    const buf = await file.arrayBuffer();
    let t;
    try { t = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { t = new TextDecoder("euc-kr").decode(buf); }
    await saveText(t, file.name);
  }

  /* ---------- 전체 스크립트 ---------- */
  const fullText = rows.filter(r => r.transcript_status === "done").map(r => r.transcript_text).join("\n\n");
  const [copied, setCopied] = useState(false);
  async function copyAll() {
    try { await navigator.clipboard.writeText(fullText); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }
  function saveTxt() {
    const co = companies.find(c => c.id === visit.company_id)?.name || "업체";
    const st = STAGES.find(x => x[0] === visit.stage)?.[1] || "";
    const name = `${co}_${st}${visit.round_no ? "_" + visit.round_no + "차" : ""}_${visit.location_type === "HQ" ? "본사" : "현장"}_회의록.txt`;
    const url = URL.createObjectURL(new Blob(["\ufeff" + fullText], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const doneCount = rows.filter(r => r.transcript_status === "done").length;
  const STATUS = { pending: "변환 대기", processing: "변환 중…", done: "변환 완료", failed: "변환 실패" };

  return (
    <>
      {pending > 0 && (
        <div className="msg warn">
          노트북에 보관 중인 녹음 {pending}건이 아직 서버에 안 올라갔습니다.{" "}
          <button className="btn sm" onClick={uploadPending} disabled={!navigator.onLine}>지금 올리기</button>
        </div>
      )}

      <div className="card">
        <h2>1. 방문 회차 선택</h2>
        <label>업체</label>
        <select value={companyId} onChange={e => { setCompanyId(e.target.value); setVisit(null); }} disabled={recording}>
          <option value="">— 업체 선택 —</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="row">
          <div><label>단계</label>
            <select value={stage} onChange={e => { setStage(e.target.value); setVisit(null); }} disabled={recording}>
              {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div><label>차수</label>
            <select value={round} onChange={e => { setRound(Number(e.target.value)); setVisit(null); }} disabled={recording}>
              {ROUNDS[stage].map(n => <option key={n} value={n}>{n === 0 ? "수준진단" : n + "차"}</option>)}
            </select>
          </div>
          <div><label>장소</label>
            <select value={loc} onChange={e => { setLoc(e.target.value); setVisit(null); }} disabled={recording || stage === "S"}>
              <option value="HQ">본사</option>
              <option value="SITE">현장</option>
            </select>
          </div>
        </div>
        {loc === "SITE" && (<><label>현장명</label><input value={siteName} onChange={e => setSiteName(e.target.value)} disabled={recording} /></>)}
        <div className="actions">
          <button className="btn primary" onClick={openVisit} disabled={busy === "visit" || recording}>이 회차 열기</button>
        </div>
        {msg && <div className={"msg " + msg.t}>{msg.s}</div>}
      </div>

      {visit && (
        <div className="card">
          <h2>2. 회의 녹음 <span className="conf">v8</span></h2>
          <div style={{ fontSize: 34, fontWeight: 500, textAlign: "center", margin: "8px 0" }}>{fmt(elapsed)}</div>
          <div className="actions" style={{ justifyContent: "center" }}>
            {!recording
              ? <button className="btn primary" onClick={startRec}>녹음 시작</button>
              : <button className="btn danger" onClick={stopRec}>녹음 종료</button>}
          </div>
          <div className="conf" style={{ textAlign: "center" }}>
            {recording ? "녹음 중에는 이 창을 닫거나 노트북을 덮지 마세요. 10분마다 자동으로 나눠 저장됩니다." : "회의 시작 전 녹음 동의를 받아주세요."}
          </div>

          {rows.length > 0 && (
            <div style={{ marginTop: 16 }}>
              {rows.map(r => (
                <div className="item" key={r.id}>
                  <div className="nm">{r.local_path || "녹음 구간 " + r.seq}{r.duration_sec ? " · " + fmt(r.duration_sec) : ""} · {r.storage_path ? STATUS[r.transcript_status] : "텍스트"}</div>
                  {r.transcript_status === "failed" && (
                    <div className="de">{r.error_message} <button className="btn sm" onClick={() => transcribe(r)}>다시 변환</button></div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {visit && !recording && (
        <div className="card">
          <h2>회의 자료 올리기</h2>
          <div className="conf">이미 만든 회의록 텍스트를 이 회차에 추가합니다. (변환 비용 없음)</div>
          <input ref={textIn} type="file" accept=".txt,text/plain" className="hidden" onChange={onTextFile} />
          <div className="actions">
            <button className="btn" disabled={busy === "up"} onClick={() => textIn.current.click()}>텍스트 파일 올리기</button>
          </div>
          <label>또는 텍스트 붙여넣기</label>
          <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="회의록 내용을 여기에 붙여넣으세요" />
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn sm" disabled={!pasteText.trim()} onClick={async () => { await saveText(pasteText, "붙여넣은 텍스트"); setPasteText(""); }}>붙여넣은 내용 추가</button>
          </div>
          {upMsg && <div className={"msg " + upMsg.t}>{upMsg.s}</div>}
        </div>
      )}

      {visit && doneCount > 0 && (
        <div className="card">
          <h2>3. 전체 스크립트</h2>
          {doneCount < rows.length && <div className="conf">아직 변환되지 않은 구간이 있습니다. 모두 완료되면 전체가 표시됩니다.</div>}
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={copyAll}>{copied ? "복사됨" : "전체 복사"}</button>
            <button className="btn" onClick={saveTxt}>텍스트 파일로 저장</button>
          </div>
          <div style={{ marginTop: 12, whiteSpace: "pre-wrap", fontSize: 15, lineHeight: 1.8, maxHeight: 520, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 14 }}>
            {fullText}
          </div>
        </div>
      )}
    </>
  );
}
