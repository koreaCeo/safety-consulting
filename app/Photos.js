"use client";
import { useEffect, useRef, useState } from "react";
import VisitTools from "./VisitTools";

const STAGES = [["DIAG", "수준진단"], ["I", "I단계"], ["S", "S단계"], ["P", "P단계"]];
// 단계별 방문 계획 (차수에 따라 본사·현장 자동)
const PLAN = {
  DIAG: [{ round: 0, loc: "HQ", label: "수준진단" }],
  I: [{ round: 1, loc: "HQ", label: "1차 본사" }, { round: 2, loc: "SITE", label: "2차 현장" }],
  S: [{ round: 3, loc: "HQ", label: "3차 본사" }],
  P: [{ round: 4, loc: "HQ", label: "4차 본사" }, { round: 5, loc: "SITE", label: "5차 현장" }],
};
const CAT = { consulting: "컨설팅", site_visit: "현장방문", finding: "지적", agreement: "협약서", cover_sign: "서명표지" };
const STAGE_OF = r => (r === 0 ? "DIAG" : r <= 2 ? "I" : r === 3 ? "S" : "P");
// 업체를 고르면 진행 중이거나 다음에 할 단계를 자동 선택
export function nextStage(visits) {
  if (!visits || !visits.length) return "I";
  const last = visits.reduce((a, b) => (b.round_no > a.round_no ? b : a));
  if (last.status === "visited" && last.round_no < 5) return STAGE_OF(last.round_no + 1);
  return STAGE_OF(last.round_no);
}

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

export default function Photos({ sb, active, preset }) {
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [stage, setStage] = useState("I");
  const [visits, setVisits] = useState({});      // 차수 → 방문 기록
  const [rules, setRules] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [urls, setUrls] = useState({});
  const [pending, setPending] = useState([]);
  const [msg, setMsg] = useState(null);
  const [vmsg, setVmsg] = useState({});           // 차수별 안내
  const [busy, setBusy] = useState("");
  const [viewer, setViewer] = useState(null);
  const [prep, setPrep] = useState(null);
  const ctx = useRef({});
  const camRef = useRef(null), albRef = useRef(null), target = useRef(null);
  ctx.current = { companyId, stage, companies };

  // 탭이 다시 열릴 때 업체 목록 새로고침
  useEffect(() => {
    if (!active) return;
    sb.from("companies").select("id, name").is("deleted_at", null).order("name").then(({ data }) => { if (data) setCompanies(data); });
  }, [active]); // eslint-disable-line

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

  // 현황판에서 넘겨받은 업체·단계로 바로 열기
  useEffect(() => {
    if (!preset) return;
    setCompanyId(preset.companyId);
    if (preset.stage) setStage(preset.stage);
  }, [preset?.n]); // eslint-disable-line

  useEffect(() => { if (companyId) load(); else { setVisits({}); setPhotos([]); setPrep(null); } }, [companyId, stage]); // eslint-disable-line

  async function chooseCompany(id) {
    setCompanyId(id); setMsg(null); setVmsg({});
    if (!id) return;
    const { data: vs } = await sb.from("visits").select("round_no, status").eq("company_id", id).is("deleted_at", null);
    setStage(nextStage(vs || []));
  }

  async function load() {
    setBusy("load");
    try {
      const { data: vs } = await sb.from("visits").select("*").eq("company_id", companyId).eq("stage", stage).is("deleted_at", null).order("created_at");
      const m = {};
      for (const v of vs || []) if (!m[v.round_no]) m[v.round_no] = v;
      setVisits(m);
      const { data: rs } = await sb.from("photo_rules").select("*").eq("stage", stage).order("sort_order");
      setRules(rs || []);
      const { data: co } = await sb.from("companies").select("prep_note, prep_updated_at").eq("id", companyId).single();
      setPrep(co?.prep_note ? co : null);
      await loadPhotos(Object.values(m).map(v => v.id));
    } catch (e) {
      setMsg({ t: "err", s: "불러오기 실패: " + (e.message || "") });
    } finally { setBusy(""); }
  }

  async function loadPhotos(ids) {
    if (!ids.length) { setPhotos([]); return; }
    const { data } = await sb.from("photos").select("*").in("visit_id", ids).is("deleted_at", null).order("seq");
    setPhotos(data || []);
    const paths = (data || []).map(p => p.storage_path).filter(Boolean);
    if (paths.length) {
      const { data: su } = await sb.storage.from("photos").createSignedUrls(paths, 3600);
      const m = {}; (su || []).forEach(x => { if (x.signedUrl) m[x.path] = x.signedUrl; });
      setUrls(m);
    }
  }

  // 해당 차수 방문 기록이 없으면 첫 사진을 올릴 때 자동으로 만듦
  async function ensureVisit(cid, st, round, loc) {
    const { data: v } = await sb.from("visits").select("*").eq("company_id", cid).eq("stage", st).eq("round_no", round).is("deleted_at", null).limit(1);
    if (v?.[0]) return v[0];
    const { data, error } = await sb.from("visits").insert({
      company_id: cid, stage: st, round_no: round, location_type: loc, site_id: null,
      actual_date: new Date().toISOString().slice(0, 10), status: "in_progress",
    }).select("*").single();
    if (error) throw error;
    return data;
  }

  /* ---------- 촬영 / 앨범 ---------- */
  function shoot(p, cat) { target.current = { ...p, cat }; camRef.current.value = ""; camRef.current.click(); }
  function album(p, cat) { target.current = { ...p, cat }; albRef.current.value = ""; albRef.current.click(); }

  async function onFiles(e) {
    const files = Array.from(e.target.files || []);
    const t = target.current;
    if (!files.length || !t || !companyId) return;
    setBusy("add");
    for (const f of files) {
      try {
        const blob = await shrink(f);
        const item = { local_id: uid(), companyId, stage, round: t.round, loc: t.loc, category: t.cat, blob,
          taken_at: new Date(f.lastModified || Date.now()).toISOString() };
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
      let v;
      if (item.visitId) {   // 이전 버전에서 보관된 사진
        const { data } = await sb.from("visits").select("*").eq("id", item.visitId).single();
        v = data;
      } else v = await ensureVisit(item.companyId, item.stage, item.round, item.loc);
      if (!v) throw new Error("방문 기록 없음");
      const { data: u } = await sb.auth.getUser();
      const path = `${u.user.id}/${v.id}/${item.local_id}.jpg`;
      const up = await sb.storage.from("photos").upload(path, item.blob, { upsert: true, contentType: "image/jpeg" });
      if (up.error) throw up.error;
      const { data: ex } = await sb.from("photos").select("seq").eq("visit_id", v.id).eq("category", item.category).is("deleted_at", null);
      const seq = Math.max(0, ...(ex || []).map(x => x.seq)) + 1;
      const { data: rl } = await sb.from("photo_rules").select("required_count").eq("stage", v.stage).eq("category", item.category).in("location_type", [v.location_type, "ANY"]).limit(1);
      const need = rl?.[0]?.required_count;
      const co = ctx.current.companies.find(c => c.id === v.company_id)?.name || "업체";
      const st = STAGES.find(s => s[0] === v.stage)?.[1] || "";
      const fileName = `${co}_${st}${v.round_no ? v.round_no + "차" : ""}_${v.location_type === "HQ" ? "본사" : "현장"}_${CAT[item.category]}_${String(seq).padStart(2, "0")}.jpg`;
      const { error } = await sb.from("photos").upsert({
        visit_id: v.id, category: item.category, seq, local_id: item.local_id,
        storage_path: path, file_name: fileName, taken_at: item.taken_at, upload_status: "done",
        is_extra: need ? seq > need : true,
      }, { onConflict: "local_id" });
      if (error) throw error;
      await idbDel(item.local_id);
      setPending(await idbAll());
      if (ctx.current.companyId === v.company_id && ctx.current.stage === v.stage) await load();
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
    await load();
  }

  /* ---------- 차수별 필요 사진 계산 ---------- */
  function slotsOf(p) {
    const v = visits[p.round];
    return rules.filter(r => r.location_type === p.loc || r.location_type === "ANY").map(r => {
      const list = v ? photos.filter(x => x.visit_id === v.id && x.category === r.category) : [];
      const pend = pending.filter(x => !x.visitId && x.companyId === companyId && x.stage === stage && x.round === p.round && x.category === r.category);
      const n = list.length + pend.length;
      return { ...r, list, pend, n, lack: Math.max(0, r.required_count - n) };
    });
  }

  async function finish(p) {
    const v = visits[p.round];
    const lack = slotsOf(p).filter(s => s.lack);
    if (!v || lack.length) {
      setVmsg(m => ({ ...m, [p.round]: { t: "err", s: "부족한 사진: " + (lack.length ? lack.map(s => `${s.label} ${s.lack}장`).join(", ") : "아직 찍은 사진 없음") } }));
      return;
    }
    if (pending.some(x => !x.visitId && x.companyId === companyId && x.round === p.round)) {
      setVmsg(m => ({ ...m, [p.round]: { t: "warn", s: "아직 서버에 안 올라간 사진이 있습니다. 인터넷 연결 후 다시 눌러주세요." } }));
      return;
    }
    await sb.from("visits").update({ status: "visited" }).eq("id", v.id);
    setVmsg(m => ({ ...m, [p.round]: { t: "info", s: "필수 사진이 모두 확보되었습니다. 방문 종료 처리했습니다." } }));
    await load();
  }

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
        <h2>1. 업체·단계 선택 <span className="conf">v26</span></h2>
        <label>업체</label>
        <select value={companyId} onChange={e => chooseCompany(e.target.value)}>
          <option value="">— 업체 선택 —</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label>단계</label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
          {STAGES.map(([v, l]) => (
            <button key={v} className={"btn sm" + (stage === v ? " primary" : "")} onClick={() => setStage(v)}>{l}</button>
          ))}
        </div>
        <div className="conf">업체를 고르면 진행 중인 단계가 자동으로 선택됩니다. 한 화면에서 이 단계의 모든 방문 사진을 찍을 수 있습니다.</div>
        {msg && <div className={"msg " + msg.t}>{msg.s}</div>}
      </div>

      {companyId && prep && (
        <div className="card">
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>다음 회차 준비자료 보기</summary>
            <div className="conf">{prep.prep_updated_at ? `저장 ${new Date(prep.prep_updated_at).toLocaleString("ko-KR")}` : ""}</div>
            <div style={{ whiteSpace: "pre-wrap", fontSize: 14, lineHeight: 1.7, marginTop: 8 }}>{prep.prep_note}</div>
          </details>
        </div>
      )}

      {companyId && PLAN[stage].map(p => {
        const v = visits[p.round];
        const slots = slotsOf(p);
        const lack = slots.reduce((a, b) => a + b.lack, 0);
        const findings = v ? photos.filter(x => x.visit_id === v.id && x.category === "finding") : [];
        return (
          <div className="card" key={p.round}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, flex: 1 }}>{p.label}</h2>
              <span className={"conf" + (lack ? " low" : "")} style={{ marginTop: 0 }}>
                {!v ? "아직 방문 기록 없음 (사진을 찍으면 자동 생성)" : lack ? `필수 사진 ${lack}장 남음` : "필수 사진 완료 ✓"}
                {v?.actual_date ? ` · ${v.actual_date}` : ""}{v?.status === "visited" ? " · 방문 종료" : ""}
              </span>
            </div>
            {v && (
              <VisitTools key={v.id + v.stage + v.round_no + v.location_type} sb={sb} visit={v}
                onChanged={() => load()} onDeleted={() => load()} />
            )}
            {slots.map(r => (
              <div key={r.category} style={{ marginTop: 16 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontWeight: 500 }}>{r.label}</strong>
                  <span className={"conf" + (r.lack ? " low" : "")}>{r.n} / {r.required_count}장{r.lack ? "" : " ✓"}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, marginTop: 8 }}>
                  {r.list.map(ph => (
                    <button key={ph.id} type="button" onClick={() => setViewer(ph)}
                      style={{ padding: 0, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", aspectRatio: "1", background: "var(--card)", cursor: "pointer" }}>
                      {urls[ph.storage_path] && <img src={urls[ph.storage_path]} alt={ph.file_name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                    </button>
                  ))}
                  {r.pend.map(ph => (
                    <div key={ph.local_id} style={{ border: "1px dashed var(--warn)", borderRadius: 8, aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--warn)", textAlign: "center" }}>
                      업로드<br />대기
                    </div>
                  ))}
                  {Array.from({ length: r.lack }).map((_, i) => (
                    <button key={"e" + i} type="button" onClick={() => shoot(p, r.category)}
                      style={{ border: "1.5px dashed var(--line2)", borderRadius: 8, aspectRatio: "1", background: "none", color: "var(--fg3)", fontSize: 13, cursor: "pointer" }}>
                      + 촬영
                    </button>
                  ))}
                </div>
                <div className="actions" style={{ marginTop: 8 }}>
                  <button className="btn sm" onClick={() => shoot(p, r.category)} disabled={busy === "add"}>카메라로 찍기</button>
                  <button className="btn sm" onClick={() => album(p, r.category)} disabled={busy === "add"}>앨범에서 고르기</button>
                </div>
              </div>
            ))}
            {findings.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <strong style={{ fontWeight: 600 }}>지적사항 작성</strong>
                <div className="conf">전문가 의견을 키워드로 적고 "분석"을 누르면 위험요인·개선대책·근거조항 초안이 만들어집니다.</div>
                {findings.map(ph => (
                  <FindingItem key={ph.id} sb={sb} photo={ph} thumb={urls[ph.storage_path]}
                    onSaved={upd => setPhotos(list => list.map(x => x.id === ph.id ? { ...x, ...upd } : x))} />
                ))}
              </div>
            )}
            <div className="actions" style={{ marginTop: 14 }}>
              <button className="btn primary sm" onClick={() => finish(p)}>{p.label} 방문 종료 점검</button>
            </div>
            {vmsg[p.round] && <div className={"msg " + vmsg[p.round].t}>{vmsg[p.round].s}</div>}
          </div>
        );
      })}

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
