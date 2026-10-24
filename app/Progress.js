"use client";
import { useEffect, useState } from "react";

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

const C = { ok: "#1d6e56", warn: "#b7791f", no: "#a32d2d", none: "#8a8a8a" };
const Dot = ({ c }) => <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 5, background: c, marginRight: 6 }} />;

export default function Progress({ sb, companyId, onGo }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");

  async function load() {
    try {
      const { data: co } = await sb.from("companies").select("progress").eq("id", companyId).single();
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
    const visitsDone = vis.every(x => x.status === "done");
    const done = visitsDone && !!pg.report;
    return { st, label, vis, ckN, scN: sc.length, pg, visitsDone, done };
  });

  // ---- 다음 할 일 ----
  let next = "모든 단계가 완료되었습니다.";
  outer:
  for (const s of sInfo) {
    if (s.st === "DIAG" && DIAG_SKIPPED) continue;
    for (const x of s.vis) {
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

  return (
    <div>
      <div style={{ background: "var(--warn-bg)", borderRadius: 8, padding: "10px 12px", fontWeight: 600, fontSize: 15 }}>
        ▶ {next}
      </div>

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
              <span className="conf" style={{ marginTop: 0, fontWeight: 600, color: skipped ? C.none : s.done ? C.ok : started ? C.warn : C.none }}>
                {skipped ? "기록 없음" : s.done ? "단계 완료" : started ? "진행 중" : "시작 전"}
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
          </div>
        );
      })}
      <div className="actions"><button className="btn sm" onClick={load}>새로고침</button></div>
    </div>
  );
}
