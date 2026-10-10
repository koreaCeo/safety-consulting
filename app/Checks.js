"use client";
import { useEffect, useRef, useState } from "react";
import { ITEMS } from "./api/checklist/items";
import { CHECK_ITEMS, CHECK_ADVICE, GRADED, STATUS, itemKey, suggestScore } from "./checkItems";

const STAGES = [["DIAG", "수준진단"], ["I", "I단계"], ["S", "S단계"], ["P", "P단계"]];
const ORDER = ["DIAG", "I", "S", "P"];
const AREAS = ["A", "B", "C", "D", "E", "F"];
const COLOR = { ok: "#1d6e56", part: "#b7791f", none: "#a32d2d", na: "#6b6b6b" };

export default function Checks({ sb, active }) {
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState("");
  const [stage, setStage] = useState("I");
  const [data, setData] = useState(null);     // {s, m, g, a}
  const [prev, setPrev] = useState(null);     // 앞 단계 체크 (S·P 변경 표시용)
  const [prevName, setPrevName] = useState("");
  const [area, setArea] = useState("A");
  const [onlyTodo, setOnlyTodo] = useState(false);
  const [saving, setSaving] = useState("");
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const latest = useRef(null);

  // 탭이 다시 열릴 때 업체 목록 새로고침 (탭을 닫지 않는 구조라서)
  useEffect(() => {
    if (!active) return;
    sb.from("companies").select("id, name").is("deleted_at", null).order("name").then(({ data }) => { if (data) setCompanies(data); });
  }, [active]); // eslint-disable-line

  useEffect(() => {
    sb.from("companies").select("id, name").is("deleted_at", null).order("name").then(({ data }) => setCompanies(data || []));
  }, [sb]);

  async function loadStage(st) {
    const { data: row } = await sb.from("stage_checks").select("data").eq("company_id", companyId).eq("stage", st).maybeSingle();
    return row?.data || null;
  }

  async function open() {
    if (!companyId) { setMsg({ t: "err", s: "업체를 선택하세요." }); return; }
    setMsg(null); setSaving("");
    let d = await loadStage(stage);
    let pv = null, pn = "";
    for (let k = ORDER.indexOf(stage) - 1; k >= 0; k--) {
      const x = await loadStage(ORDER[k]);
      if (x) { pv = x; pn = STAGES.find(s => s[0] === ORDER[k])[1]; break; }
    }
    const isInherit = stage === "S" || stage === "P";
    if (!d) d = isInherit && pv ? JSON.parse(JSON.stringify(pv)) : { s: {}, m: {}, g: {}, a: {} };
    setPrev(isInherit ? pv : null); setPrevName(isInherit && pv ? pn : "");
    setData(d); latest.current = d;
    if (isInherit && pv) setMsg({ t: "info", s: `${pn} 체크 결과를 불러왔습니다. 달라진 항목만 다시 누르세요.` });
  }

  function update(fn) {
    setData(cur => {
      const next = fn(JSON.parse(JSON.stringify(cur)));
      latest.current = next;
      clearTimeout(timer.current);
      setSaving("저장 대기…");
      timer.current = setTimeout(save, 800);
      return next;
    });
  }

  async function save() {
    setSaving("저장 중…");
    const { error } = await sb.from("stage_checks").upsert(
      { company_id: companyId, stage, data: latest.current, updated_at: new Date().toISOString() },
      { onConflict: "company_id,stage" });
    setSaving(error ? "저장 실패: " + error.message : "저장됨");
  }

  const setStatus = (k, v) => update(d => { d.s[k] = d.s[k] === v ? undefined : v; if (!d.s[k]) delete d.s[k]; return d; });
  const setMemo = (k, v) => update(d => { if (v) d.m[k] = v; else delete d.m[k]; return d; });
  const setGrade = (r, v) => update(d => { d.g = d.g || {}; if (v === "") delete d.g[r]; else d.g[r] = Number(v); return d; });
  const setAdvice = (r, v) => update(d => { d.a = d.a || {}; if (v) d.a[r] = v; else delete d.a[r]; return d; });

  const rows = ITEMS.filter(it => CHECK_ITEMS[String(it.r)]);
  const total = rows.reduce((n, it) => n + CHECK_ITEMS[String(it.r)].length, 0);
  const done = data ? Object.keys(data.s).length : 0;
  const rowDone = it => CHECK_ITEMS[String(it.r)].every((_, i) => data?.s[itemKey(it.r, i)]);
  const shown = rows.filter(it => it.ind.startsWith(area) && (!onlyTodo || !rowDone(it)));
  const changed = k => prev && (prev.s?.[k] || "") !== (data?.s?.[k] || "");

  function Item({ r, i, it }) {
    const k = itemKey(r, i);
    const v = data.s[k];
    return (
      <div style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
        <div style={{ fontSize: 14, display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 160 }}>{it.text}</span>
          <span className="conf" style={{ marginTop: 0 }}>{it.how}{it.pts ? ` · ${it.pts}` : ""}</span>
          {changed(k) && <span className="conf" style={{ marginTop: 0, color: COLOR.part }}>변경</span>}
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {STATUS.map(([sv, label]) => (
            <button key={sv} type="button" onClick={() => setStatus(k, sv)}
              style={{
                font: "inherit", fontSize: 13, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                border: `1.5px solid ${v === sv ? COLOR[sv] : "var(--line2)"}`,
                background: v === sv ? COLOR[sv] : "var(--card)", color: v === sv ? "#fff" : "var(--fg)",
              }}>{label}</button>
          ))}
        </div>
        <input style={{ marginTop: 6, fontSize: 14, padding: "6px 9px" }} placeholder="메모 (예: 날짜 미갱신)"
          defaultValue={data.m[k] || ""} onBlur={e => { if ((e.target.value || "") !== (data.m[k] || "")) setMemo(k, e.target.value.trim()); }} />
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>현장 체크리스트 <span className="conf">v20</span></h2>
        <div className="row">
          <div><label>업체</label>
            <select value={companyId} onChange={e => { setCompanyId(e.target.value); setData(null); }}>
              <option value="">— 업체 선택 —</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div><label>단계</label>
            <select value={stage} onChange={e => { setStage(e.target.value); setData(null); }}>
              {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        <div className="actions"><button className="btn primary" onClick={open}>불러오기</button></div>
        {msg && <div className={"msg " + msg.t}>{msg.s}</div>}
      </div>

      {data && (
        <div className="card">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: 1, fontSize: 14 }}>체크 {done} / {total}</div>
            <span className="conf" style={{ marginTop: 0 }}>{saving}</span>
          </div>
          <div style={{ height: 6, background: "var(--line)", borderRadius: 3, marginTop: 6 }}>
            <div style={{ width: `${(done / total) * 100}%`, height: 6, background: "var(--accent)", borderRadius: 3 }} />
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            {AREAS.map(a => {
              const rs = rows.filter(it => it.ind.startsWith(a));
              const n = rs.reduce((x, it) => x + CHECK_ITEMS[String(it.r)].length, 0);
              const d = rs.reduce((x, it) => x + CHECK_ITEMS[String(it.r)].filter((_, i) => data.s[itemKey(it.r, i)]).length, 0);
              return <button key={a} className={"btn sm" + (area === a ? " primary" : "")} onClick={() => setArea(a)}>{a} {d}/{n}</button>;
            })}
            <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "0 0 0 8px", cursor: "pointer" }}>
              <input type="checkbox" checked={onlyTodo} onChange={e => setOnlyTodo(e.target.checked)} style={{ width: 16, height: 16 }} /> 남은 것만
            </label>
          </div>
          {prevName && <div className="conf">"변경" 표시는 {prevName} 대비 상태가 달라진 항목입니다 (엑셀 노란 바탕 대상).</div>}
        </div>
      )}

      {data && shown.map(it => {
        const r = String(it.r);
        const list = CHECK_ITEMS[r].map((x, i) => ({ ...x, i }));
        const hq = list.filter(x => x.side === "본사"), st = list.filter(x => x.side === "현장");
        const sc = suggestScore(r, it.max, data);
        return (
          <div className="card" key={r}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 600, flex: 1 }}>{it.ind}</div>
              <div className="conf" style={{ marginTop: 0 }}>
                배점 {it.max}{sc && sc.score != null ? ` · 제안 ${sc.score}점` : ""}{sc ? ` — ${sc.why}` : ""}
              </div>
            </div>
            <details style={{ marginTop: 4 }}>
              <summary className="conf" style={{ cursor: "pointer", marginTop: 0 }}>평가기준 원문 · 요구문서</summary>
              <div className="de" style={{ whiteSpace: "pre-wrap" }}>{it.crit}</div>
              {it.docs && <div className="conf">요구문서: {it.docs}</div>}
            </details>
            {GRADED[r] && (
              <div style={{ marginTop: 8 }}>
                <label>단계 선택 (점수)</label>
                <select value={data.g?.[r] ?? ""} onChange={e => setGrade(r, e.target.value)}>
                  <option value="">— 선택 —</option>
                  {GRADED[r].map(([l, p], gi) => <option key={gi} value={gi}>{l} ({p}점)</option>)}
                </select>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginTop: 8 }}>
              {[["본사", hq, "#DDEBF7"], ["현장", st, "#E2EFDA"]].map(([side, xs, bg]) => xs.length > 0 && (
                <div key={side} style={{ borderLeft: `4px solid ${bg}`, paddingLeft: 10 }}>
                  <div style={{ display: "inline-block", background: bg, color: "#23221f", fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 4 }}>{side}</div>
                  {xs.map(x => <Item key={x.i} r={r} i={x.i} it={x} />)}
                </div>
              ))}
            </div>
            <label style={{ marginTop: 10 }}>권고 메모 (이번에 제안한 방법)</label>
            <textarea style={{ minHeight: 44, fontSize: 14 }} placeholder={CHECK_ADVICE[r] ? `예: ${CHECK_ADVICE[r]}` : "예: 전기안전교육 시간에 함께 교육"}
              defaultValue={data.a?.[r] || ""} onBlur={e => { if ((e.target.value || "") !== (data.a?.[r] || "")) setAdvice(r, e.target.value.trim()); }} />
          </div>
        );
      })}
    </>
  );
}
