"use client";
import { useEffect, useRef, useState } from "react";
import VisitTools from "./VisitTools";

const STAGES = [["DIAG", "수준진단"], ["I", "I단계"], ["S", "S단계"], ["P", "P단계"]];
const ROUNDS = { DIAG: [0], I: [1, 2], S: [3], P: [4, 5] };
const CAT = { consulting: "컨설팅", site_visit: "현장방문", finding: "지적", agreement: "협약서" };

/* ---------- 폰 내부 임시 보관 (인터넷 끊김 대비) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("consult-photo", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pending", { keyPath: "local_id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(v) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction("pending", "readwrite"); t.objectStore("pending").put(v); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
async function idbAll() {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction("pending").objectStore("pending").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
}
async function idbDel(k) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction("pending", "readwrite"); t.objectStore("pending").delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); });
}

async function shrink(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(b => res(b), "image/jpeg", 0.8));
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

export default function Photos({ sb }) {
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [stage, setStage] = useState("DIAG");
  const [round, setRound] = useState(0);
  const [loc, setLoc] = useState("HQ");
  const [siteName, setSiteName] = useState("");
  const [visit, setVisit] = useState(null);
  const [rules, setRules] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [urls, setUrls] = useState({});
  const [pending, setPending] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState("");
  const [viewer, setViewer] = useState(null);
  const visitRef = useRef(null);
  const camRef = useRef(null), albRef = useRef(null), targetCat = useRef("");

  useEffect(() => {
    (async () => {
      const { data } = await sb.from("companies").select("id, name").is("deleted_at", null).order("name");
      setCompanies(data || []);
      setPending(await idbAll());
    })();
    const on = () => uploadPending();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setRound(ROUNDS[stage][0]); if (stage === "S") setLoc("HQ"); }, [stage]);

  /* ---------- 회차 열기 ---------- */
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
      const { data: v } = await sb.from("visits").select("*").eq("company_id", companyId).eq("stage", stage).eq("round_no", round).is("deleted_at", null).limit(1);
      let vv = v?.[0];
      if (!vv) {
        const { data, error } = await sb.from("visits").insert({
          company_id: companyId, stage, round_no: round, location_type: loc, site_id: siteId,
          actual_date: new Date().toISOString().slice(0, 10), status: "in_progress",
        }).select("*").single();
        if (error) throw error;
        vv = data;
      }
      const { data: rs } = await sb.from("photo_rules").select("*").eq("stage", vv.stage).in("location_type", [vv.location_type, "ANY"]).order("sort_order");
      setRules(rs || []);
      setVisit(vv); visitRef.current = vv;
      await loadPhotos(vv.id);
    } catch (e) {
      setMsg({ t: "err", s: "회차를 열지 못했습니다: " + (e.message || "") });
    } finally { setBusy(""); }
  }

  async function loadPhotos(visitId) {
    const { data } = await sb.from("photos").select("*").eq("visit_id", visitId).is("deleted_at", null).order("seq");
    setPhotos(data || []);
    const paths = (data || []).map(p => p.storage_path).filter(Boolean);
    if (paths.length) {
      const { data: su } = await sb.storage.from("photos").createSignedUrls(paths, 3600);
      const m = {}; (su || []).forEach(x => { if (x.signedUrl) m[x.path] = x.signedUrl; });
      setUrls(m);
    }
  }

  /* ---------- 촬영 / 앨범 ---------- */
  function shoot(cat) { targetCat.current = cat; camRef.current.value = ""; camRef.current.click(); }
  function album(cat) { targetCat.current = cat; albRef.current.value = ""; albRef.current.click(); }

  async function onFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length || !visitRef.current) return;
    const cat = targetCat.current;
    setBusy("add");
    for (const f of files) {
      try {
        const blob = await shrink(f);
        const item = { local_id: uid(), visitId: visitRef.current.id, category: cat, blob, taken_at: new Date(f.lastModified || Date.now()).toISOString() };
        await idbPut(item);
        setPending(await idbAll());
        await uploadOne(item);
      } catch (err) {
        setMsg({ t: "err", s: "사진 처리 실패: " + (err.message || "") });
      }
    }
    setBusy("");
  }

  async function uploadOne(item) {
    if (!navigator.onLine) return;
    try {
      const { data: u } = await sb.auth.getUser();
      const path = `${u.user.id}/${item.visitId}/${item.local_id}.jpg`;
      const up = await sb.storage.from("photos").upload(path, item.blob, { upsert: true, contentType: "image/jpeg" });
      if (up.error) throw up.error;

      const { data: ex } = await sb.from("photos").select("seq").eq("visit_id", item.visitId).eq("category", item.category).is("deleted_at", null);
      const seq = Math.max(0, ...(ex || []).map(x => x.seq)) + 1;
      const rule = rules.find(r => r.category === item.category);
      const v = visitRef.current;
      const co = companies.find(c => c.id === v?.company_id)?.name || "업체";
      const st = STAGES.find(s => s[0] === v?.stage)?.[1] || "";
      const fileName = `${co}_${st}${v?.round_no ? v.round_no + "차" : ""}_${v?.location_type === "HQ" ? "본사" : "현장"}_${CAT[item.category]}_${String(seq).padStart(2, "0")}.jpg`;

      const { error } = await sb.from("photos").upsert({
        visit_id: item.visitId, category: item.category, seq, local_id: item.local_id,
        storage_path: path, file_name: fileName, taken_at: item.taken_at, upload_status: "done",
        is_extra: rule ? seq > rule.required_count : true,
      }, { onConflict: "local_id" });
      if (error) throw error;
      await idbDel(item.local_id);
      setPending(await idbAll());
      if (visitRef.current?.id === item.visitId) await loadPhotos(item.visitId);
    } catch (e) {
      setMsg({ t: "warn", s: "업로드 대기 중 (인터넷 연결되면 자동으로 올라갑니다)" });
    }
  }

  async function uploadPending() {
    for (const it of await idbAll()) await uploadOne(it);
  }

  async function remove(p) {
    if (!confirm("이 사진을 삭제할까요?")) return;
    await sb.from("photos").update({ deleted_at: new Date().toISOString() }).eq("id", p.id);
    await sb.storage.from("photos").remove([p.storage_path]);
    setViewer(null);
    await loadPhotos(visit.id);
  }

  /* ---------- 방문 종료 점검 ---------- */
  const missing = rules.map(r => {
    const n = photos.filter(p => p.category === r.category).length + pending.filter(p => p.visitId === visit?.id && p.category === r.category).length;
    return { ...r, n, lack: Math.max(0, r.required_count - n) };
  });
  const totalLack = missing.reduce((a, b) => a + b.lack, 0);

  async function finish() {
    if (totalLack > 0) {
      setMsg({ t: "err", s: "부족한 사진: " + missing.filter(m => m.lack).map(m => `${m.label} ${m.lack}장`).join(", ") });
      return;
    }
    if (pending.some(p => p.visitId === visit.id)) {
      setMsg({ t: "warn", s: "아직 서버에 안 올라간 사진이 있습니다. 인터넷 연결 후 다시 눌러주세요." });
      return;
    }
    await sb.from("visits").update({ status: "visited" }).eq("id", visit.id);
    setMsg({ t: "info", s: "필수 사진이 모두 확보되었습니다. 방문 종료 처리했습니다." });
  }

  const myPending = pending.filter(p => p.visitId === visit?.id);

  return (
    <>
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
      <input ref={albRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />

      {pending.length > 0 && (
        <div className="msg warn">
          폰에 보관 중인 사진 {pending.length}장이 아직 서버에 안 올라갔습니다.{" "}
          <button className="btn sm" onClick={uploadPending}>지금 올리기</button>
        </div>
      )}

      <div className="card">
        <h2>1. 방문 회차 선택 <span className="conf">v11</span></h2>
        <label>업체</label>
        <select value={companyId} onChange={e => { setCompanyId(e.target.value); setVisit(null); }}>
          <option value="">— 업체 선택 —</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="row">
          <div><label>단계</label>
            <select value={stage} onChange={e => { setStage(e.target.value); setVisit(null); }}>
              {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div><label>차수</label>
            <select value={round} onChange={e => { setRound(Number(e.target.value)); setVisit(null); }}>
              {ROUNDS[stage].map(n => <option key={n} value={n}>{n === 0 ? "수준진단" : n + "차"}</option>)}
            </select>
          </div>
          <div><label>장소</label>
            <select value={loc} onChange={e => { setLoc(e.target.value); setVisit(null); }} disabled={stage === "S"}>
              <option value="HQ">본사</option>
              <option value="SITE">현장</option>
            </select>
          </div>
        </div>
        {loc === "SITE" && (<><label>현장명</label><input value={siteName} onChange={e => setSiteName(e.target.value)} /></>)}
        <div className="actions">
          <button className="btn primary" onClick={openVisit} disabled={busy === "visit"}>이 회차 열기</button>
        </div>
        {visit && (
          <VisitTools key={visit.id + visit.stage + visit.round_no + visit.location_type} sb={sb} visit={visit}
            onChanged={async v => {
              setVisit(v); visitRef.current = v;
              const { data: rs } = await sb.from("photo_rules").select("*").eq("stage", v.stage).in("location_type", [v.location_type, "ANY"]).order("sort_order");
              setRules(rs || []);
              await loadPhotos(v.id);
            }}
            onDeleted={() => { setVisit(null); visitRef.current = null; setPhotos([]); setRules([]); }} />
        )}
        {msg && !visit && <div className={"msg " + msg.t}>{msg.s}</div>}
      </div>

      {visit && (
        <>
          <div className="card">
            <h2>2. 사진 촬영</h2>
            <div className={"msg " + (totalLack ? "warn" : "info")} style={{ marginTop: 0 }}>
              {totalLack ? `필수 사진 ${totalLack}장 남았습니다.` : "필수 사진을 모두 찍었습니다."}
              {busy === "add" && " · 사진 처리 중…"}
            </div>

            {missing.map(r => {
              const list = photos.filter(p => p.category === r.category);
              const pend = myPending.filter(p => p.category === r.category);
              return (
                <div key={r.category} style={{ marginTop: 18 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontWeight: 500 }}>{r.label}</strong>
                    <span className={"conf" + (r.lack ? " low" : "")}>{r.n} / {r.required_count}장{r.lack ? "" : " ✓"}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, marginTop: 8 }}>
                    {list.map(p => (
                      <button key={p.id} type="button" onClick={() => setViewer(p)}
                        style={{ padding: 0, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", aspectRatio: "1", background: "var(--card)", cursor: "pointer" }}>
                        {urls[p.storage_path] && <img src={urls[p.storage_path]} alt={p.file_name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                      </button>
                    ))}
                    {pend.map(p => (
                      <div key={p.local_id} style={{ border: "1px dashed var(--warn)", borderRadius: 8, aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--warn)", textAlign: "center" }}>
                        업로드<br />대기
                      </div>
                    ))}
                    {Array.from({ length: r.lack }).map((_, i) => (
                      <button key={"e" + i} type="button" onClick={() => shoot(r.category)}
                        style={{ border: "1.5px dashed var(--line2)", borderRadius: 8, aspectRatio: "1", background: "none", color: "var(--fg3)", fontSize: 13, cursor: "pointer" }}>
                        + 촬영
                      </button>
                    ))}
                  </div>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button className="btn sm" onClick={() => shoot(r.category)}>카메라로 찍기</button>
                    <button className="btn sm" onClick={() => album(r.category)}>앨범에서 고르기</button>
                  </div>
                </div>
              );
            })}
          </div>

          {photos.some(p => p.category === "finding") && (
            <div className="card">
              <h2>지적사항 작성</h2>
              <div className="conf">전문가 의견을 키워드로 적고 "분석"을 누르면 위험요인·개선대책·근거조항 초안이 만들어집니다. 수정 후 저장하세요.</div>
              {photos.filter(p => p.category === "finding").map(p => (
                <FindingItem key={p.id} sb={sb} photo={p} thumb={urls[p.storage_path]}
                  onSaved={upd => setPhotos(list => list.map(x => x.id === p.id ? { ...x, ...upd } : x))} />
              ))}
            </div>
          )}

          <div className="card">
            <h2>3. 방문 종료</h2>
            <div className="conf">현장을 떠나기 전에 누르세요. 부족한 사진이 있으면 알려드립니다.</div>
            <div className="actions">
              <button className="btn primary" onClick={finish}>방문 종료 점검</button>
            </div>
            {msg && <div className={"msg " + msg.t}>{msg.s}</div>}
          </div>
        </>
      )}

      {viewer && (
        <div onClick={() => setViewer(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 50, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
          {urls[viewer.storage_path] && <img src={urls[viewer.storage_path]} alt={viewer.file_name} style={{ maxWidth: "100%", maxHeight: "75vh", borderRadius: 8 }} />}
          <div style={{ color: "#eee", fontSize: 13, margin: "10px 0", textAlign: "center", wordBreak: "break-all" }}>{viewer.file_name}</div>
          <div className="actions" onClick={e => e.stopPropagation()}>
            <button className="btn danger" onClick={() => remove(viewer)}>삭제</button>
            <button className="btn" onClick={() => setViewer(null)}>닫기</button>
          </div>
        </div>
      )}
    </>
  );
}

function FindingItem({ sb, photo, thumb, onSaved }) {
  const [note, setNote] = useState(photo.expert_note || "");
  const [risk, setRisk] = useState(photo.risk_text || "");
  const [measures, setMeasures] = useState(photo.measures_text || "");
  const [legal, setLegal] = useState(photo.legal_text || "");
  const [cands, setCands] = useState([]);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);

  async function analyze() {
    if (!note.trim()) { setMsg({ t: "err", s: "전문가 의견을 먼저 적어주세요." }); return; }
    setBusy("ai"); setMsg({ t: "info", s: "분석 중입니다… (10~20초)" });
    try {
      const { data: s } = await sb.storage.from("photos").createSignedUrl(photo.storage_path, 600);
      const { data: ss } = await sb.auth.getSession();
      const r = await fetch("/api/finding", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (ss.session?.access_token || "") },
        body: JSON.stringify({ url: s.signedUrl, note }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "분석 실패");
      setRisk(d.risk || "");
      setMeasures((d.measures || []).map((m, i) => `${i + 1}. ${m.replace(/^\d+[.)]\s*/, "")}`).join("\n"));
      const laws = d.laws || [];
      setCands(laws);
      setPicked(laws.length ? [laws[0]] : []);
      setLegal(laws.length ? laws[0] : "근거조항 확인 필요");
      setMsg({ t: "info", s: "초안을 만들었습니다. 확인·수정 후 저장하세요." });
    } catch (e) {
      setMsg({ t: "err", s: e.message || "분석 실패" });
    } finally { setBusy(""); }
  }

  async function save() {
    setBusy("save");
    const upd = { expert_note: note, risk_text: risk, measures_text: measures, legal_text: legal };
    const { error } = await sb.from("photos").update(upd).eq("id", photo.id);
    if (error) setMsg({ t: "err", s: "저장 실패: " + error.message });
    else { setMsg({ t: "info", s: "저장했습니다." }); onSaved(upd); }
    setBusy("");
  }

  return (
    <div className="item" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        {thumb && <img src={thumb} alt={photo.file_name} style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />}
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="de">{photo.file_name}</div>
          <label>전문가 의견</label>
          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="예: 가설 전기 불량으로 감전 및 화재발생 위험" style={{ minHeight: 52 }} />
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn primary sm" onClick={analyze} disabled={!!busy}>분석</button>
          </div>
        </div>
      </div>
      <label>위험요인</label>
      <textarea value={risk} onChange={e => setRisk(e.target.value)} />
      <label>개선대책</label>
      <textarea value={measures} onChange={e => setMeasures(e.target.value)} style={{ minHeight: 96 }} />
      <label>근거조항{cands.length > 1 ? " — 적용할 조문을 선택하세요" : ""}</label>
      {cands.length > 1 && (
        <div style={{ marginBottom: 6 }}>
          {cands.map(c => (
            <label key={c} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14, color: "var(--fg)", margin: "6px 0", cursor: "pointer" }}>
              <input type="checkbox" style={{ width: 18, height: 18, flex: "none", marginTop: 2, accentColor: "var(--accent)" }}
                checked={picked.includes(c)}
                onChange={() => {
                  const next = picked.includes(c) ? picked.filter(x => x !== c) : cands.filter(x => x === c || picked.includes(x));
                  setPicked(next);
                  setLegal(next.join("\n"));
                }} />
              <span>{c}</span>
            </label>
          ))}
        </div>
      )}
      <textarea value={legal} onChange={e => setLegal(e.target.value)} />
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={save} disabled={!!busy}>저장</button>
      </div>
      {msg && <div className={"msg " + msg.t}>{msg.s}</div>}
    </div>
  );
}
