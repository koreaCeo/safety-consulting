"use client";
import { useEffect, useRef, useState } from "react";
import { ITEMS } from "./api/checklist/items";
import { readChecklistXlsx } from "./xlsxRead";

// 방문 계획 (사장님 호칭 기준: 1·2차 = I단계, 3차 = S단계, 4·5차 = P단계)
const PLAN = [
  { stage: "DIAG", round: 0, loc: "HQ", label: "수준진단" },
  { stage: "I", round: 1, loc: "HQ", label: "1차 본사" },
  { stage: "I", round: 2, loc: "SITE", label: "2차 현장" },
  { stage: "S", round: 3, loc: "HQ", label: "3차 본사" },
  { stage: "P", round: 4, loc: "HQ", label: "4차 본사" },
  { stage: "P", round: 5, loc: "SITE", label: "5차 현장" },
];
const STAGES = [["DIAG", "수준진단"], ["I", "I단계 (1·2차)"], ["S", "S단계 (3차)"], ["P", "P단계 (4·5차)"]];
const NEEDS_GENERAL = { DIAG: true, I: true, P: true };
const TOTAL_CHECK = 135;

// 드라이브 파일이 프로그램 최종본보다 새것인지 (saved: progress[st].final.xlsx|hwpx)
function driveNew(x, saved) {
  if (!x) return false;
  if (!saved) return true;
  if (saved.drive_id) return saved.drive_id !== x.id || x.modifiedTime > (saved.drive_mod || "");
  return new Date(x.modifiedTime) > new Date(saved.at || 0); // 직접 올린 최종본보다 드라이브에서 나중에 고친 경우
}
const KIND_NAME = { xlsx: "평가지표", hwpx: "결과보고서" };
async function bearer(sb) { const { data } = await sb.auth.getSession(); return "Bearer " + (data.session?.access_token || ""); }

const C = { ok: "#1d6e56", warn: "#b7791f", no: "#a32d2d", none: "#8a8a8a" };
const Dot = ({ c }) => <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 5, background: c, marginRight: 6 }} />;

export default function Progress({ sb, companyId, onGo }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [drive, setDrive] = useState(null); // { state: "loading"|"ok"|"off"|"err", files, msg }

  async function loadDrive(name) {
    setDrive(x => ({ ...(x || {}), state: x?.files ? "ok" : "loading" }));
    try {
      const r = await fetch("/api/drive", { method: "POST", headers: { "content-type": "application/json", authorization: await bearer(sb) },
        body: JSON.stringify({ action: "list", name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "드라이브 확인 실패");
      setDrive(j.configured === false ? { state: "off" } : { state: "ok", files: j.files || {} });
    } catch (e) { setDrive({ state: "err", msg: e.message }); }
  }

  async function load() {
    try {
      const { data: co } = await sb.from("companies").select("progress, name").eq("id", companyId).single();
      const { data: vs } = await sb.from("visits").select("id, stage, round_no, location_type, actual_date, created_at")
        .eq("company_id", companyId).is("deleted_at", null);
      const ids = (vs || []).map(v => v.id);
      let recs = [], photos = [];
      if (ids.length) {
        recs = (await sb.from("recordings").select("visit_id, transcript_status").in("visit_id", ids)).data || [];
        photos = (await sb.from("photos").select("visit_id, category, risk_text").in("visit_id", ids).is("deleted_at", null)).data || [];
      }
      const { data: rules } = await sb.from("photo_rules").select("stage, location_type, category, label, required_count");
      const { data: checks } = await sb.from("stage_checks").select("stage, data").eq("company_id", companyId);
      const { data: scores } = await sb.from("stage_scores").select("stage, score, status_text").eq("company_id", companyId);
      setD({ progress: co?.progress || {}, vs: vs || [], recs, photos, rules: rules || [], checks: checks || [], scores: scores || [] });
      setErr("");
      loadDrive(co?.name || "");
    } catch (e) { setErr(e.message || "불러오기 실패"); }
  }
  useEffect(() => { load(); }, [companyId]); // eslint-disable-line

  async function toggle(stage, key) {
    const p = JSON.parse(JSON.stringify(d.progress || {}));
    p[stage] = p[stage] || {};
    p[stage][key] = !p[stage][key];
    setD(x => ({ ...x, progress: p }));
    const { error } = await sb.from("companies").update({ progress: p }).eq("id", companyId);
    if (error) { setErr("저장 실패: " + error.message); load(); }
  }

  if (err) return <div className="msg err">{err}</div>;
  if (!d) return <div className="conf">현황 불러오는 중…</div>;

  // ---- 방문별 상태 ----
  const visitOf = p => d.vs.find(v => v.stage === p.stage && v.round_no === p.round);
  const vInfo = PLAN.map(p => {
    const v = visitOf(p);
    if (!v) {
      const rules = d.rules.filter(r => r.stage === p.stage && (r.location_type === p.loc || r.location_type === "ANY"));
      return { ...p, v: null, status: "none", items: [{ label: "회의록", ok: false }, ...rules.map(r => ({ label: `${(r.label || r.category).replace(/ 사진$/, "")} 0/${r.required_count}`, ok: false }))] };
    }
    const loc = v.location_type;
    const transcript = d.recs.some(r => r.visit_id === v.id && r.transcript_status === "done");
    const rules = d.rules.filter(r => r.stage === v.stage && (r.location_type === loc || r.location_type === "ANY"));
    const gaps = rules.map(r => ({ label: r.label || r.category, need: r.required_count,
      got: d.photos.filter(x => x.visit_id === v.id && x.category === r.category).length }))
      .filter(g => g.got < g.need);
    const findings = d.photos.filter(x => x.visit_id === v.id && x.category === "finding");
    const findingsDone = findings.filter(x => (x.risk_text || "").trim()).length;
    const done = transcript && gaps.length === 0;
    const items = [{ label: "회의록", ok: transcript },
      ...rules.map(r => { const got = d.photos.filter(x => x.visit_id === v.id && x.category === r.category).length;
        return { label: `${(r.label || r.category).replace(/ 사진$/, "")} ${Math.min(got, r.required_count)}/${r.required_count}`, ok: got >= r.required_count }; }),
      ...(findings.length ? [{ label: `지적사항 작성 ${findingsDone}/${findings.length}`, ok: findingsDone >= findings.length }] : [])];
    return { ...p, v, loc, transcript, gaps, findings: findings.length, findingsDone, items, status: done ? "done" : "doing" };
  });
  const DIAG_SKIPPED = !visitOf(PLAN[0]) && d.vs.some(v => v.stage !== "DIAG");

  // ---- 단계별 상태 ----
  const sInfo = STAGES.map(([st, label]) => {
    const vis = vInfo.filter(x => x.stage === st);
    const ck = d.checks.find(c => c.stage === st);
    const ckN = ck ? Object.keys(ck.data?.s || {}).length : 0;
    const sc = d.scores.filter(s => s.stage === st && ((s.score || "") !== "" || (s.status_text || "").trim()));
    const pg = d.progress[st] || {};
    // 최종본(평가지표·결과보고서)을 둘 다 올렸으면 프로그램 기록이 빠져도 그 단계는 끝난 것으로 봄
    const finalsDone = !!(pg.final?.xlsx && pg.final?.hwpx);
    const visitsDone = vis.every(x => x.status === "done") || finalsDone;
    const done = visitsDone && !!pg.report;
    return { st, label, vis, ckN, scN: sc.length, pg, visitsDone, finalsDone, done };
  });

  // ---- 다음 할 일 ----
  let next = "모든 단계가 완료되었습니다.";
  outer:
  for (const s of sInfo) {
    if (s.st === "DIAG" && DIAG_SKIPPED) continue;
    if (!s.finalsDone) for (const x of s.vis) {
      if (x.status === "none") { next = `다음 방문: ${x.label}`; break outer; }
      if (x.status === "doing") {
        const why = [!x.transcript && "회의록 없음", ...x.gaps.map(g => `${g.label} ${g.need - g.got}장 부족`)].filter(Boolean).join(", ");
        next = `${x.label} 마무리: ${why}`; break outer;
      }
    }
    if (s.st !== "DIAG" && !s.pg.eval) { next = `${s.label} 평가지표 완료 체크 필요`; break; }
    if (!s.pg.report) { next = `${s.label} 결과보고서 미제출`; break; }
    if (NEEDS_GENERAL[s.st] && !s.pg.general) { next = `${s.label} 일반현황 미수령`; break; }
  }

  const Chip = ({ ok, children, onClick }) => (
    <span onClick={onClick}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", margin: "4px 6px 0 0", borderRadius: 14, fontSize: 13,
        cursor: onClick ? "pointer" : "default", border: "1px solid " + (ok ? "#9fd4c1" : "#efb8b8"),
        background: ok ? "#e7f5ef" : "#fdeeee", color: ok ? C.ok : C.no, fontWeight: 500 }}>
      {ok ? "✓" : "✗"} {children}
    </span>
  );
  const Bar = ({ n, t }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <div style={{ flex: 1, height: 8, background: "#eceae4", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${t ? Math.round(n / t * 100) : 0}%`, height: "100%", background: n >= t ? C.ok : C.warn }} />
      </div>
      <span className="conf" style={{ marginTop: 0, minWidth: 64, textAlign: "right" }}>{n}/{t} 완료</span>
    </div>
  );
  const mail = d.progress.mail || {};
  const newOnDrive = drive?.state === "ok" ? ["I", "S", "P"].flatMap(st => ["xlsx", "hwpx"]
    .filter(k => driveNew(drive.files?.[st]?.[k], d.progress[st]?.final?.[k])).map(k => `${ST_NAME[st]} ${KIND_NAME[k]}`)) : [];

  return (
    <div>
      <div style={{ background: "var(--warn-bg)", borderRadius: 8, padding: "10px 12px", fontWeight: 600, fontSize: 15 }}>
        ▶ {next}
      </div>
      {newOnDrive.length > 0 && <div className="msg warn" style={{ marginTop: 8 }}>
        구글 드라이브에 새 최종본이 있습니다: {newOnDrive.join(", ")} — 아래 단계별 '드라이브에서 가져오기'를 누르세요.</div>}
      {drive?.state === "off" && <div className="conf">구글 드라이브 연결 설정 전 (Vercel 환경변수 GOOGLE_SERVICE_ACCOUNT 필요)</div>}
      {drive?.state === "err" && <div className="msg err" style={{ marginTop: 8 }}>구글 드라이브 확인 실패: {drive.msg}</div>}

      {sInfo.map(s => {
        const skipped = s.st === "DIAG" && DIAG_SKIPPED;
        const flags = s.st === "DIAG" ? [["report", "수준진단 보고"], ["general", "일반현황 수령"]]
          : [["eval", "평가지표 완료"], ["report", "결과보고서 제출"], ...(NEEDS_GENERAL[s.st] ? [["general", "일반현황 수령"]] : [])];
        const all = [...s.vis.flatMap(x => x.items), ...flags.map(([k]) => ({ ok: !!s.pg[k] }))];
        const doneN = all.filter(x => x.ok).length;
        const started = s.vis.some(x => x.status !== "none");
        return (
          <div key={s.st} className="item" style={{ marginTop: 10, opacity: skipped ? 0.6 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div className="nm" style={{ flex: 1, margin: 0, fontWeight: 600 }}>{s.label}</div>
              <span className="conf" style={{ marginTop: 0, fontWeight: 600, color: skipped ? C.none : s.done ? C.ok : started || s.finalsDone ? C.warn : C.none }}>
                {skipped ? "기록 없음" : s.done ? "단계 완료" : started || s.finalsDone ? "진행 중" : "시작 전"}
              </span>
              {s.st !== "DIAG" && <button className="btn sm" onClick={() => onGo("check", { companyId, stage: s.st })}>평가지표</button>}
            </div>
            {!skipped && <Bar n={doneN} t={all.length} />}

            {!skipped && s.vis.map(x => (
              <div key={x.round} style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, fontSize: 14, minWidth: 120 }}>
                    <b>{x.label}</b>{x.v?.actual_date ? ` · ${x.v.actual_date}` : " · 미방문"}
                  </div>
                  <button className="btn sm" onClick={() => onGo("rec", { companyId, stage: x.stage, round: x.round, loc: x.v?.location_type || x.loc })}>녹음</button>
                  <button className="btn sm" onClick={() => onGo("photo", { companyId, stage: x.stage, round: x.round, loc: x.v?.location_type || x.loc })}>사진</button>
                  {x.stage !== "DIAG" && <button className="btn sm" onClick={() => onGo("ck", { companyId, stage: x.stage })}>체크</button>}
                </div>
                <div>{x.items.map((it, i) => <Chip key={i} ok={it.ok}>{it.label}</Chip>)}</div>
              </div>
            ))}

            {!skipped && (
              <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 6 }}>
                {s.st !== "DIAG" && <div className="conf" style={{ marginTop: 0 }}>체크리스트 {s.ckN}/{TOTAL_CHECK} · 평가지표 저장 {s.scN}항목 (참고)</div>}
                <div>
                  {flags.map(([k, l]) => <Chip key={k} ok={!!s.pg[k]} onClick={() => toggle(s.st, k)}>{l}</Chip>)}
                  {NEEDS_GENERAL[s.st] && s.st !== "DIAG" && mail.general_sent_at &&
                    <Chip ok>일반현황 요청 메일 {new Date(mail.general_sent_at).toLocaleDateString("ko-KR")}</Chip>}
                </div>
                <div className="conf">완료·제출·수령 표시는 눌러서 바꿀 수 있습니다.</div>
              </div>
            )}
            {s.st !== "DIAG" && <Finals sb={sb} companyId={companyId} st={s.st} progress={d.progress} onSaved={load} dv={drive?.state === "ok" ? drive.files?.[s.st] || {} : null} />}
          </div>
        );
      })}
      <div className="actions"><button className="btn sm" onClick={load}>새로고침</button></div>
    </div>
  );
}

/* ---------- 단계 최종본 등록 (최종 평가지표 엑셀·결과보고서 한글) ---------- */
const ST_NAME = { I: "I단계", S: "S단계", P: "P단계" };
function Finals({ sb, companyId, st, progress, onSaved, dv }) {
  const xRef = useRef(null), hRef = useRef(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const f = progress?.[st]?.final || {};
  const day = iso => iso ? new Date(iso).toLocaleDateString("ko-KR") : "";

  async function savePg(mut) {
    const { data: co, error } = await sb.from("companies").select("progress").eq("id", companyId).single();
    if (error) throw error;
    const p = co?.progress || {};
    p[st] = p[st] || {};
    mut(p[st]);
    const { error: e2 } = await sb.from("companies").update({ progress: p }).eq("id", companyId);
    if (e2) throw e2;
  }

  async function upFile(file, kind) {
    const { data: u } = await sb.auth.getUser();
    const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${u.user.id}/finals/${companyId}/${st}_${kind === "xlsx" ? "eval" : "report"}.${ext}`;
    const { error } = await sb.storage.from("photos").upload(path, file, { upsert: true, contentType: "application/octet-stream" });
    if (error) throw error;
    return path;
  }

  // 평가지표 엑셀 내용을 그 단계 확정본으로 저장 (직접 올리기·드라이브 공통). 취소하면 false
  async function importXlsx(buf, name, src) {
    const r = await readChecklistXlsx(buf, ITEMS.map(it => it.r));
    if (r.n < 10) throw new Error(`내용이 있는 항목이 ${r.n}개뿐입니다. 평가지표 최종본이 맞는지 확인하세요.`);
    if (!confirm(`${ST_NAME[st]} 평가지표를 이 파일 내용으로 바꿉니다.\n\n파일: ${name}\n항목 ${r.n}개 · 합계 ${r.total}점\n\n프로그램에 저장된 ${ST_NAME[st]} 내용은 이 파일 내용으로 덮어씁니다.`)) return false;
    const payload = ITEMS.map(it => {
        const v = r.rows[it.r] || {};
        return { company_id: companyId, stage: st, item_code: String(it.r), score: v.g || "", status_text: v.i || "", improvement: v.j || "" };
      });
    const { error } = await sb.from("stage_scores").upsert(payload, { onConflict: "company_id,stage,item_code" });
    if (error) throw error;
    const path = await upFile(new File([buf], name), "xlsx");
    await savePg(g => { g.final = { ...(g.final || {}), xlsx: { name, path, at: new Date().toISOString(), n: r.n, total: r.total, ...(src || {}) } }; g.eval = true; });
    setMsg({ t: "info", s: `${ST_NAME[st]} 평가지표 최종본을 저장했습니다 — 항목 ${r.n}개 · 합계 ${r.total}점.${st !== "P" ? " 다음 단계 초안은 이 내용을 이어받습니다." : ""}` });
    onSaved();
    return true;
  }

  async function onXlsx(e) {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    setBusy("x"); setMsg(null);
    try {
      await importXlsx(await file.arrayBuffer(), file.name);
    } catch (err) {
      setMsg({ t: "err", s: "평가지표 최종본 등록 실패: " + (err.message || "") });
    } finally { setBusy(""); }
  }

  async function onHwpx(e) {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    setBusy("h"); setMsg(null);
    try {
      const path = await upFile(file, "hwpx");
      await savePg(g => { g.final = { ...(g.final || {}), hwpx: { name: file.name, path, at: new Date().toISOString() } }; g.report = true; });
      setMsg({ t: "info", s: `${ST_NAME[st]} 결과보고서 최종본을 보관했습니다.${st !== "P" ? " 다음 단계 '보고서 재료 내려받기' 압축에 자동으로 들어갑니다." : ""}` });
      onSaved();
    } catch (err) {
      setMsg({ t: "err", s: "결과보고서 최종본 등록 실패: " + (err.message || "") });
    } finally { setBusy(""); }
  }

  // 구글 드라이브에서 가져오기
  async function fromDrive(kind) {
    const x = dv?.[kind];
    if (!x) return;
    const src = { drive_id: x.id, drive_mod: x.modifiedTime };
    setBusy(kind === "xlsx" ? "dx" : "dh"); setMsg(null);
    try {
      if (kind === "xlsx") {
        const r = await fetch("/api/drive", { method: "POST", headers: { "content-type": "application/json", authorization: await bearer(sb) },
          body: JSON.stringify({ action: "get", id: x.id }) });
        if (!r.ok) { let m = ""; try { m = (await r.json()).error || ""; } catch {} throw new Error(m || "드라이브에서 받기 실패"); }
        await importXlsx(await r.arrayBuffer(), x.name, src);
      } else {
        if (f.hwpx && !confirm(`${ST_NAME[st]} 결과보고서 최종본을 드라이브 파일로 바꿉니다.\n\n파일: ${x.name}`)) return;
        const r = await fetch("/api/drive", { method: "POST", headers: { "content-type": "application/json", authorization: await bearer(sb) },
          body: JSON.stringify({ action: "save", id: x.id, companyId, stage: st }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "드라이브에서 받기 실패");
        await savePg(g => { g.final = { ...(g.final || {}), hwpx: { name: j.name, path: j.path, at: new Date().toISOString(), ...src } }; g.report = true; });
        setMsg({ t: "info", s: `${ST_NAME[st]} 결과보고서 최종본을 드라이브에서 가져왔습니다.${st !== "P" ? " 다음 단계 '보고서 재료 내려받기' 압축에 자동으로 들어갑니다." : ""}` });
        onSaved();
      }
    } catch (err) {
      setMsg({ t: "err", s: `${KIND_NAME[kind]} 드라이브 가져오기 실패: ` + (err.message || "") });
    } finally { setBusy(""); }
  }

  async function get(x) {
    const { data, error } = await sb.storage.from("photos").createSignedUrl(x.path, 600, { download: x.name });
    if (error) { setMsg({ t: "err", s: "내려받기 실패: " + error.message }); return; }
    window.location.href = data.signedUrl;
  }

  const DriveLine = ({ kind }) => {
    const x = dv?.[kind];
    if (!x) return null;
    const fresh = driveNew(x, f[kind]);
    if (!fresh) return f[kind]?.drive_id === x.id ? <div className="conf" style={{ marginTop: 2 }}>드라이브 최신본 반영됨</div> : null;
    const b = kind === "xlsx" ? "dx" : "dh";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 4, padding: "6px 8px", background: "var(--warn-bg)", borderRadius: 6, fontSize: 13 }}>
        <div style={{ flex: 1, minWidth: 180 }}>드라이브 새 파일: {x.name} · {day(x.modifiedTime)}</div>
        <button className="btn sm" onClick={() => fromDrive(kind)} disabled={!!busy}>{busy === b ? "가져오는 중…" : "드라이브에서 가져오기"}</button>
      </div>
    );
  };

  const Row = ({ label, x, info, onUp, upLabel, b }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
      <div style={{ flex: 1, minWidth: 180, fontSize: 14 }}>
        <span style={{ color: x ? C.ok : C.no, fontWeight: 600 }}>{x ? "✓" : "✗"}</span> {label}
        {x && <span className="conf" style={{ marginTop: 0 }}> · {x.name} · {day(x.at)}{info ? " · " + info : ""}</span>}
      </div>
      {x && <button className="btn sm" onClick={() => get(x)}>받기</button>}
      <button className="btn sm" onClick={onUp} disabled={!!busy}>{busy === b ? "올리는 중…" : x ? "다시 올리기" : upLabel}</button>
    </div>
  );

  return (
    <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>최종본 등록 <span className="conf" style={{ fontWeight: 400 }}>v28</span></div>
      <Row label="평가지표 최종본 (엑셀)" x={f.xlsx} info={f.xlsx ? `합계 ${f.xlsx.total}점` : ""} b="x"
        onUp={() => xRef.current?.click()} upLabel="엑셀 올리기" />
      <DriveLine kind="xlsx" />
      <Row label="결과보고서 최종본 (한글)" x={f.hwpx} b="h"
        onUp={() => hRef.current?.click()} upLabel="한글 올리기" />
      <DriveLine kind="hwpx" />
      <input ref={xRef} type="file" accept=".xlsx" className="hidden" onChange={onXlsx} />
      <input ref={hRef} type="file" accept=".hwpx,.hwp" className="hidden" onChange={onHwpx} />
      {msg && <div className={"msg " + msg.t}>{msg.s}</div>}
    </div>
  );
}
