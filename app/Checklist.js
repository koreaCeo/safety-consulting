"use client";
import { useEffect, useState } from "react";
import JSZip from "jszip";
import { ITEMS } from "./api/checklist/items";
import { suggestScore } from "./checkItems";

const STAGES = [["DIAG", "수준진단"], ["I", "I단계"], ["S", "S단계"], ["P", "P단계"]];
const ORDER = ["DIAG", "I", "S", "P"];
const INHERIT = { S: true, P: true };

export default function Checklist({ sb, active }) {
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [stage, setStage] = useState("DIAG");
  const [rows, setRows] = useState({});
  const [changed, setChanged] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [baseFrom, setBaseFrom] = useState("");
  const [prevStage, setPrevStage] = useState({});   // 바로 앞 단계 내용(S·P 변경 표시 기준)
  const [flags, setFlags] = useState({});           // r -> {nb, over}
  const [checks, setChecks] = useState(null);       // 현장 체크리스트 결과
  const [transcript, setTranscript] = useState("");
  const [visitInfo, setVisitInfo] = useState("");
  const [visits, setVisits] = useState([]);
  const [revVisit, setRevVisit] = useState("");
  const [review, setReview] = useState(null);   // {ok, unclear, missing, issues}
  const [answers, setAnswers] = useState({});   // key -> 답
  const [showOk, setShowOk] = useState(false);
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);

  // 탭이 다시 열릴 때 업체 목록 새로고침 (탭을 닫지 않는 구조라서)
  useEffect(() => {
    if (!active) return;
    sb.from("companies").select("id, name").is("deleted_at", null).order("name").then(({ data }) => { if (data) setCompanies(data); });
  }, [active]); // eslint-disable-line

  useEffect(() => {
    sb.from("companies").select("id, name").is("deleted_at", null).order("name").then(({ data }) => setCompanies(data || []));
  }, [sb]);

  async function token() {
    const { data } = await sb.auth.getSession();
    return data.session?.access_token || "";
  }

  async function loadStageRows(st) {
    const { data } = await sb.from("stage_scores").select("item_code, score, status_text, improvement")
      .eq("company_id", companyId).eq("stage", st);
    const m = {};
    for (const x of data || []) {
      if (x.score || x.status_text || x.improvement) m[x.item_code] = { g: x.score || "", i: x.status_text || "", j: x.improvement || "" };
    }
    return m;
  }

  async function open() {
    if (!companyId) { setMsg({ t: "err", s: "업체를 선택하세요." }); return; }
    setBusy("load"); setMsg(null); setChanged({});
    try {
      // 1) 저장된 이 단계 내용
      let m = await loadStageRows(stage);
      let from = "";
      // 2) S·P단계: 바로 앞 단계 내용(변경 표시 기준), 비어 있으면 이어받기
      let pv = {};
      if (INHERIT[stage]) {
        for (let k = ORDER.indexOf(stage) - 1; k >= 0; k--) {
          const pm = await loadStageRows(ORDER[k]);
          if (Object.keys(pm).length) { pv = pm; from = STAGES.find(s => s[0] === ORDER[k])[1]; break; }
        }
        if (!Object.keys(m).length) m = { ...pv }; else from = "";
      }
      setPrevStage(pv); setFlags({});
      const { data: ck } = await sb.from("stage_checks").select("data").eq("company_id", companyId).eq("stage", stage).maybeSingle();
      setChecks(ck?.data || null);
      setRows(m); setBaseFrom(from);

      // 3) 이 단계 회차들의 회의 스크립트 모으기
      const { data: vs } = await sb.from("visits").select("id, round_no, location_type, review_json")
        .eq("company_id", companyId).eq("stage", stage).is("deleted_at", null).order("round_no");
      setVisits(vs || []);
      const last = (vs || [])[(vs || []).length - 1];
      setRevVisit(last?.id || "");
      setReview(last?.review_json?.result || null);
      setAnswers(last?.review_json?.answers || {});
      const ids = (vs || []).map(v => v.id);
      let text = "";
      if (ids.length) {
        const { data: rs } = await sb.from("recordings").select("visit_id, seq, transcript_text, transcript_status")
          .in("visit_id", ids).eq("transcript_status", "done").order("seq");
        for (const v of vs) {
          const part = (rs || []).filter(r => r.visit_id === v.id).map(r => r.transcript_text).join("\n");
          if (part.trim()) text += `\n\n[${v.round_no ? v.round_no + "차 " : ""}${v.location_type === "HQ" ? "본사" : "현장"} 회의]\n${part}`;
        }
      }
      setTranscript(text.trim());
      setVisitInfo(ids.length ? `회차 ${ids.length}개, 회의 스크립트 ${text.trim().length.toLocaleString()}자` : "이 단계에 열린 회차가 없습니다.");
      setLoaded(true);
    } catch (e) {
      setMsg({ t: "err", s: "불러오기 실패: " + (e.message || "") });
    } finally { setBusy(""); }
  }

  const vLabel = v => v ? `${STAGES.find(x => x[0] === stage)[1]} ${v.round_no ? v.round_no + "차 " : ""}${v.location_type === "HQ" ? "본사" : "현장"}` : "";
  const keyOf = (kind, x, i) => kind === "issue" ? `issue:${i}` : `${kind}:${x.r}`;

  function pickVisit(id) {
    setRevVisit(id);
    const v = visits.find(x => x.id === id);
    setReview(v?.review_json?.result || null);
    setAnswers(v?.review_json?.answers || {});
  }

  async function runReview() {
    const v = visits.find(x => x.id === revVisit);
    if (!v) { setMsg({ t: "err", s: "점검할 회차를 선택하세요." }); return; }
    if (!transcript) { setMsg({ t: "err", s: "회의록이 없습니다. 회의 녹음 탭에서 녹음하거나 클로바노트 텍스트를 먼저 넣어주세요." }); return; }
    setBusy("review"); setMsg({ t: "info", s: "회의록을 평가지표와 대조하는 중입니다… (30초~1분)" });
    try {
      const co = companies.find(c => c.id === companyId)?.name;
      const { data: cinfo } = await sb.from("companies").select("prep_note").eq("id", companyId).single();
      const r = await fetch("/api/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (await token()) },
        body: JSON.stringify({
          action: "review", company: co, stage, visitLabel: vLabel(v),
          location: v.location_type === "HQ" ? "본사" : "현장",
          transcript, prev: rows, prep: cinfo?.prep_note || "",
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "점검 실패");
      setReview(d); setAnswers({});
      await sb.from("visits").update({ review_json: { result: d, answers: {} } }).eq("id", v.id);
      setVisits(vs => vs.map(x => x.id === v.id ? { ...x, review_json: { result: d, answers: {} } } : x));
      setMsg({ t: "info", s: `점검 완료 — 확인됨 ${d.ok.length} · 애매함 ${d.unclear.length} · 논의 안 됨 ${d.missing.length} · 회의록 확인 ${d.issues.length}` });
    } catch (e) {
      setMsg({ t: "err", s: e.message || "점검 실패" });
    } finally { setBusy(""); }
  }

  async function saveAnswers() {
    const v = visits.find(x => x.id === revVisit); if (!v) return;
    setBusy("ans");
    const rj = { result: review, answers };
    const { error } = await sb.from("visits").update({ review_json: rj }).eq("id", v.id);
    setBusy("");
    if (error) { setMsg({ t: "err", s: "답변 저장 실패: " + error.message }); return; }
    setVisits(vs => vs.map(x => x.id === v.id ? { ...x, review_json: rj } : x));
    setMsg({ t: "info", s: "답변을 저장했습니다. 이제 AI 초안 만들기를 누르면 답변이 우선 반영됩니다." });
  }

  // 이 단계 모든 회차의 점검 답변을 초안용으로 모음
  function collectAnswers() {
    const out = [];
    for (const v of visits) {
      const rj = v.id === revVisit ? { result: review, answers } : v.review_json;
      if (!rj?.result) continue;
      const res = rj.result, an = rj.answers || {};
      for (const k of ["unclear", "missing"]) for (const x of res[k] || []) out.push({ r: x.r, q: x.q, a: an[keyOf(k, x)] || "" });
      (res.issues || []).forEach((x, i) => out.push({ quote: x.quote, q: x.q, a: an[keyOf("issue", x, i)] || "" }));
    }
    return out;
  }

  async function draft() {
    if (!transcript && !checks) { setMsg({ t: "err", s: "이 단계의 회의록과 체크 결과가 없습니다. 체크리스트 탭에서 체크하거나 회의록을 먼저 넣어주세요." }); return; }
    setBusy("ai"); setMsg({ t: "info", s: "초안 작성 중입니다… (1~3분 걸립니다. 창을 닫지 마세요)" });
    try {
      const co = companies.find(c => c.id === companyId)?.name;
      const r = await fetch("/api/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (await token()) },
        body: JSON.stringify({ action: "draft", company: co, stage, transcript, prev: INHERIT[stage] ? rows : {}, answers: collectAnswers(), checks }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "초안 실패");
      const n = Object.keys(d.rows || {}).length;
      setRows(prev => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(d.rows || {})) next[k] = { g: prev[k]?.g || "", i: v.i, j: v.j };
        return next;
      });
      setFlags(Object.fromEntries(Object.entries(d.rows || {}).map(([k, v]) => [k, { nb: !!v.nb, over: !!v.over }])));
      setChanged(Object.fromEntries(Object.keys(d.rows || {}).map(k => [k, true])));
      const nb = Object.values(d.rows || {}).filter(v => v.nb).length;
      const ov = Object.values(d.rows || {}).filter(v => v.over).length;
      setMsg({ t: "info", s: `${n}개 기준에 초안을 넣었습니다.${nb ? ` 근거 없음 ${nb}개(빨간 표시)는 꼭 확인하세요.` : ""}${ov ? ` 분량 초과 ${ov}개(주황 표시)는 줄여주세요.` : ""}` });
    } catch (e) {
      setMsg({ t: "err", s: e.message || "초안 실패" });
    } finally { setBusy(""); }
  }

  function edit(r, k, v) {
    setRows(prev => ({ ...prev, [r]: { ...(prev[r] || { g: "", i: "", j: "" }), [k]: v } }));
  }

  function fillScores() {
    if (!checks) { setMsg({ t: "err", s: "이 단계의 체크 결과가 없습니다. 체크리스트 탭에서 먼저 체크하세요." }); return; }
    let n = 0;
    setRows(prev => {
      const next = { ...prev };
      for (const it of ITEMS) {
        const sc = suggestScore(it.r, it.max, checks);
        if (sc && sc.score != null) { next[it.r] = { ...(next[it.r] || { i: "", j: "" }), g: String(sc.score) }; n++; }
      }
      return next;
    });
    setMsg({ t: "info", s: `체크 결과로 점수를 채웠습니다. 보완·미수립은 0점으로 들어갔으니 확인 후 수정하세요. 저장을 눌러야 반영됩니다.` });
  }

  async function save() {
    setBusy("save"); setMsg(null);
    const payload = ITEMS.map(it => {
      const v = rows[it.r] || {};
      return { company_id: companyId, stage, item_code: String(it.r), score: (v.g || "").toString(), status_text: v.i || "", improvement: v.j || "" };
    });
    const { error } = await sb.from("stage_scores").upsert(payload, { onConflict: "company_id,stage,item_code" });
    setBusy("");
    if (error) setMsg({ t: "err", s: "저장 실패: " + error.message });
    else { setMsg({ t: "info", s: "저장했습니다." }); setBaseFrom(""); }
  }

  async function bundle() {
    if (!visits.length) { setMsg({ t: "err", s: "이 단계에 열린 회차가 없습니다." }); return; }
    setBusy("zip"); setMsg({ t: "info", s: "재료를 모으는 중입니다… (사진이 많으면 1~2분)" });
    try {
      const co = companies.find(c => c.id === companyId)?.name || "업체";
      const stName = STAGES.find(x => x[0] === stage)[1];
      const zip = new JSZip();
      const label = v => `${v.round_no ? v.round_no + "차_" : ""}${v.location_type === "HQ" ? "본사" : "현장"}`;
      const ids = visits.map(v => v.id);

      // 1) 회의록 (회차별)
      const { data: rs } = await sb.from("recordings").select("visit_id, seq, local_path, transcript_text, transcript_status")
        .in("visit_id", ids).eq("transcript_status", "done").order("seq");
      for (const v of visits) {
        const t = (rs || []).filter(r => r.visit_id === v.id).map(r => r.transcript_text).join("\n\n");
        if (t.trim()) zip.file(`회의록/${stName}_${label(v)}_회의록.txt`, "\ufeff" + t);
      }

      // 2) 사진 + 지적사항
      const { data: ph } = await sb.from("photos").select("*").in("visit_id", ids).is("deleted_at", null).order("seq");
      const list = (ph || []).filter(p => p.storage_path);
      let n = 0;
      const findings = [];
      if (list.length) {
        const { data: su } = await sb.storage.from("photos").createSignedUrls(list.map(p => p.storage_path), 600);
        const urlOf = {}; (su || []).forEach(x => { if (x.signedUrl) urlOf[x.path] = x.signedUrl; });
        for (const p of list) {
          const v = visits.find(x => x.id === p.visit_id);
          const name = p.file_name || `${label(v)}_${p.category}_${p.seq}.jpg`;
          const u = urlOf[p.storage_path];
          if (u) {
            const b = await (await fetch(u)).blob();
            zip.file(`사진/${label(v)}/${name}`, b);
            n++;
            setMsg({ t: "info", s: `사진 내려받는 중… (${n}/${list.length})` });
          }
          if (p.category === "finding" && (p.risk_text || p.measures_text || p.expert_note)) {
            findings.push(`[${name}]\n전문가 의견: ${p.expert_note || "-"}\n위험요인: ${p.risk_text || "-"}\n개선대책:\n${p.measures_text || "-"}\n근거조항:\n${p.legal_text || "-"}`);
          }
        }
      }
      if (findings.length) zip.file(`지적사항_${stName}.txt`, "\ufeff" + findings.join("\n\n----------\n\n"));

      // 3) 평가지표 엑셀 (현재 화면 내용 + 점수)
      const r = await fetch("/api/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (await token()) },
        body: JSON.stringify({ action: "export", company: co, stage, rows, highlight: changedRows() }),
      });
      if (r.ok) zip.file(`${co}_${stName}_평가지표.xlsx`, await r.blob());

      zip.file("안내.txt", "\ufeff" + `${co} ${stName} 보고서 재료\n회차 ${visits.length}개 · 사진 ${n}장 · 지적사항 ${findings.length}건\n\n이 압축 파일과 앞 단계 최종본(평가지표·결과보고서), 일반현황을 채팅에 올리고\n"${stName} 평가지표 다듬고 결과보고서 만들어줘"라고 요청하세요.`);

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${co}_${stName}_보고서재료.zip`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setMsg({ t: "info", s: `내려받았습니다 — 회의록 ${visits.length}회차, 사진 ${n}장, 지적사항 ${findings.length}건, 평가지표 엑셀` });
    } catch (e) {
      setMsg({ t: "err", s: "재료 묶음 실패: " + (e.message || "") });
    } finally { setBusy(""); }
  }

  // S·P단계: 앞 단계와 달라진 칸 (엑셀 노란 바탕)
  function changedRows() {
    if (!INHERIT[stage] || !Object.keys(prevStage).length) return [];
    return ITEMS.map(it => it.r).filter(r => {
      const a = rows[r] || {}, b = prevStage[r] || {};
      return (a.i || "").trim() !== (b.i || "").trim() || (a.j || "").trim() !== (b.j || "").trim();
    });
  }

  async function download() {
    setBusy("xlsx"); setMsg(null);
    try {
      const co = companies.find(c => c.id === companyId)?.name || "업체";
      const r = await fetch("/api/checklist", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (await token()) },
        body: JSON.stringify({ action: "export", company: co, stage, rows, highlight: changedRows() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "내려받기 실패");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${co}_${STAGES.find(s => s[0] === stage)[1]}_평가지표.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      setMsg({ t: "err", s: e.message });
    } finally { setBusy(""); }
  }

  const filled = r => { const v = rows[r]; return v && (v.g || v.i || v.j); };
  const list = onlyFilled ? ITEMS.filter(it => filled(it.r)) : ITEMS;
  let lastInd = "";

  return (
    <>
      <div className="card">
        <h2>평가지표 체크리스트 <span className="conf">v20</span></h2>
        <label>업체</label>
        <select value={companyId} onChange={e => { setCompanyId(e.target.value); setLoaded(false); }}>
          <option value="">— 업체 선택 —</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label>단계</label>
        <select value={stage} onChange={e => { setStage(e.target.value); setLoaded(false); }}>
          {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <div className="actions">
          <button className="btn primary" onClick={open} disabled={!!busy}>불러오기</button>
        </div>
        {!loaded && msg && <div className={"msg " + msg.t}>{msg.s}</div>}
      </div>

      {loaded && (
        <div className="card">
          <h2>1. 빠진 항목 점검 <span className="conf">현장 떠나기 전</span></h2>
          <div className="conf" style={{ marginTop: 0 }}>회의록을 평가지표 기준·요구문서와 대조해 애매하거나 논의 안 된 항목, 알아듣기 어려운 회의록 부분을 찾습니다. 답을 짧게 적으면 초안에 우선 반영됩니다.</div>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div>
              <label>이번 방문</label>
              <select value={revVisit} onChange={e => pickVisit(e.target.value)}>
                {visits.map(v => <option key={v.id} value={v.id}>{vLabel(v)}{v.review_json?.result ? " (점검함)" : ""}</option>)}
              </select>
            </div>
            <div style={{ flex: "0 0 auto" }}>
              <button className="btn primary" onClick={runReview} disabled={!!busy || !visits.length}>{review ? "다시 점검" : "점검하기"}</button>
            </div>
          </div>
          {review && (
            <div style={{ marginTop: 14 }}>
              {[["missing", "논의 안 됨", review.missing], ["unclear", "애매함", review.unclear]].map(([k, title, arr]) => arr.length > 0 && (
                <div key={k} style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 600 }}>{title} ({arr.length})</div>
                  {arr.map(x => {
                    const it = ITEMS.find(i => i.r === x.r);
                    const kk = keyOf(k, x);
                    return (
                      <div className="item" key={kk} style={{ marginTop: 8 }}>
                        <div className="conf" style={{ marginTop: 0 }}>{it?.ind} · {it?.method}</div>
                        <div style={{ fontSize: 14, marginTop: 4 }}>{x.q}</div>
                        <input style={{ marginTop: 6 }} placeholder="짧게 답 (예: 확인, 실행계획 미수립)" value={answers[kk] || ""}
                          onChange={e => setAnswers(a => ({ ...a, [kk]: e.target.value }))} />
                      </div>
                    );
                  })}
                </div>
              ))}
              {review.issues.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 600 }}>회의록 확인 필요 ({review.issues.length})</div>
                  {review.issues.map((x, i) => {
                    const kk = keyOf("issue", x, i);
                    return (
                      <div className="item" key={kk} style={{ marginTop: 8 }}>
                        <div className="de" style={{ marginTop: 0 }}>원문: "{x.quote}"</div>
                        {x.guess && <div className="conf">이해한 내용: {x.guess}</div>}
                        <div style={{ fontSize: 14, marginTop: 4 }}>{x.q}</div>
                        <input style={{ marginTop: 6 }} placeholder="맞으면 '맞음', 틀리면 바른 내용" value={answers[kk] || ""}
                          onChange={e => setAnswers(a => ({ ...a, [kk]: e.target.value }))} />
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ marginTop: 12 }}>
                <button className="btn sm" onClick={() => setShowOk(v => !v)}>확인됨 {review.ok.length}개 {showOk ? "접기" : "보기"}</button>
                {showOk && <div className="de" style={{ marginTop: 6 }}>{review.ok.map(r => ITEMS.find(i => i.r === r)?.ind).filter((x, i, a) => a.indexOf(x) === i).join(" · ")}</div>}
              </div>
              <div className="actions">
                <button className="btn primary" onClick={saveAnswers} disabled={!!busy}>답변 저장</button>
              </div>
            </div>
          )}
        </div>
      )}

      {loaded && (
        <div className="card">
          <h2>2. 평가지표 초안</h2>
          <div className="conf" style={{ marginTop: 0 }}>{visitInfo}{checks ? ` · 현장 체크 ${Object.keys(checks.s || {}).length}개 반영` : " · 현장 체크 없음"}</div>
          {baseFrom && <div className="msg warn">{baseFrom} 내용을 불러왔습니다. 이번 회의에서 달라진 부분만 AI가 고칩니다.</div>}
          <div className="actions">
            <button className="btn primary" onClick={draft} disabled={!!busy}>AI 초안 만들기</button>
            <button className="btn" onClick={fillScores} disabled={!!busy}>체크 결과로 점수 채우기</button>
            <button className="btn" onClick={save} disabled={!!busy}>저장</button>
            <button className="btn" onClick={download} disabled={!!busy}>엑셀 내려받기</button>
            <button className="btn" onClick={bundle} disabled={!!busy}>보고서 재료 내려받기</button>
          </div>
          <div className="conf">점수까지 넣고 저장한 뒤 "보고서 재료 내려받기"를 누르면 회의록·사진·지적사항·평가지표 엑셀이 압축 하나로 받아집니다.</div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={onlyFilled} onChange={e => setOnlyFilled(e.target.checked)} style={{ width: 18, height: 18 }} />
            내용 있는 항목만 보기
          </label>
          {msg && <div className={"msg " + msg.t}>{msg.s}</div>}

          <div style={{ marginTop: 12 }}>
            {list.map(it => {
              const v = rows[it.r] || { g: "", i: "", j: "" };
              const head = it.ind !== lastInd; lastInd = it.ind;
              return (
                <div key={it.r}>
                  {head && <div style={{ fontWeight: 600, marginTop: 18, fontSize: 15 }}>{it.ind}</div>}
                  <div className="item" style={{ marginTop: 8, borderColor: flags[it.r]?.nb ? "var(--danger)" : flags[it.r]?.over ? "var(--warn)" : undefined }}>
                    {it.r === 4 && <div className="conf" style={{ marginTop: 0 }}>작성 제외 항목 (사전의무교육)</div>}
                    {flags[it.r]?.nb && <div className="msg err" style={{ marginTop: 0, padding: "4px 8px" }}>근거 없음 — 회의록에 내용이 없어 평가기준으로 채웠습니다. 확인 후 수정하세요.</div>}
                    {flags[it.r]?.over && <div className="msg warn" style={{ marginTop: 0, padding: "4px 8px" }}>분량 초과 — 엑셀 칸을 넘칠 수 있습니다.</div>}
                    {INHERIT[stage] && changedRows().includes(it.r) && <div className="conf" style={{ marginTop: 0 }}>앞 단계에서 변경됨 (엑셀 노란 바탕)</div>}
                    <div className="de" style={{ whiteSpace: "pre-wrap", marginTop: 0 }}>{it.crit}</div>
                    <div className="row" style={{ alignItems: "flex-end" }}>
                      <div style={{ flex: "0 0 140px" }}>
                        <label>점수 (배점 {it.max}) — 직접 입력</label>
                        <input value={v.g} onChange={e => edit(it.r, "g", e.target.value)} />
                      </div>
                    </div>
                    <label>현황 및 문제점</label>
                    <textarea value={v.i} onChange={e => edit(it.r, "i", e.target.value)} />
                    <label>개선대책</label>
                    <textarea value={v.j} onChange={e => edit(it.r, "j", e.target.value)} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="actions">
            <button className="btn primary" onClick={save} disabled={!!busy}>저장</button>
            <button className="btn" onClick={download} disabled={!!busy}>엑셀 내려받기</button>
          </div>
        </div>
      )}
    </>
  );
}
