"use client";
import { useState } from "react";

const STAGES = [["DIAG", "수준진단"], ["I", "I단계"], ["S", "S단계"], ["P", "P단계"]];
const ROUNDS = { DIAG: [0], I: [1, 2], S: [3], P: [4, 5] };

export function visitLabel(v) {
  if (!v) return "";
  const st = STAGES.find(s => s[0] === v.stage)?.[1] || "";
  const rd = v.round_no ? ` ${v.round_no}차` : "";
  return `${st}${rd} · ${v.location_type === "HQ" ? "본사" : "현장"}`;
}

// 회차 수정·삭제. onChanged(새 회차), onDeleted()
export default function VisitTools({ sb, visit, onChanged, onDeleted, disabled }) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState(visit.stage);
  const [round, setRound] = useState(visit.round_no);
  const [loc, setLoc] = useState(visit.location_type);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function startEdit() {
    setStage(visit.stage); setRound(visit.round_no); setLoc(visit.location_type); setMsg(null);
    setOpen(true);
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const siteId = null;
      const { data, error } = await sb.from("visits")
        .update({ stage, round_no: round, location_type: loc, site_id: siteId })
        .eq("id", visit.id).select("*").single();
      if (error) {
        if (error.code === "23505") throw new Error("이 업체에 같은 단계·차수 회차가 이미 있습니다.");
        throw error;
      }
      setOpen(false);
      onChanged(data);
    } catch (e) {
      setMsg({ t: "err", s: "수정 실패: " + (e.message || "") });
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setMsg(null);
    try {
      const [{ data: ph }, { data: rc }] = await Promise.all([
        sb.from("photos").select("storage_path").eq("visit_id", visit.id),
        sb.from("recordings").select("storage_path").eq("visit_id", visit.id),
      ]);
      const np = (ph || []).length, nr = (rc || []).length;
      const warn = np || nr
        ? `이 회차의 사진 ${np}장, 녹음·회의록 ${nr}건이 모두 삭제됩니다. 되돌릴 수 없습니다. 삭제할까요?`
        : "이 회차를 삭제할까요?";
      if (!confirm(warn)) { setBusy(false); return; }
      const pp = (ph || []).map(x => x.storage_path).filter(Boolean);
      const rp = (rc || []).map(x => x.storage_path).filter(Boolean);
      if (pp.length) await sb.storage.from("photos").remove(pp);
      if (rp.length) await sb.storage.from("recordings").remove(rp);
      const { error } = await sb.from("visits").delete().eq("id", visit.id);
      if (error) throw error;
      onDeleted();
    } catch (e) {
      setMsg({ t: "err", s: "삭제 실패: " + (e.message || "") });
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <span className="conf" style={{ marginTop: 0 }}>열린 회차: <b>{visitLabel(visit)}</b></span>
        <button className="btn sm" onClick={startEdit} disabled={disabled || busy}>회차 수정</button>
        <button className="btn sm danger" onClick={remove} disabled={disabled || busy}>회차 삭제</button>
        {msg && <div className={"msg " + msg.t} style={{ width: "100%" }}>{msg.s}</div>}
      </div>
    );
  }

  return (
    <div className="item" style={{ marginTop: 10 }}>
      <div className="nm">회차 수정 — 사진·녹음은 그대로 따라옵니다</div>
      <div className="row">
        <div><label>단계</label>
          <select value={stage} onChange={e => { const s = e.target.value; setStage(s); setRound(ROUNDS[s][0]); if (s === "S") setLoc("HQ"); }}>
            {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div><label>차수</label>
          <select value={round} onChange={e => setRound(Number(e.target.value))}>
            {ROUNDS[stage].map(n => <option key={n} value={n}>{n === 0 ? "수준진단" : n + "차"}</option>)}
          </select>
        </div>
        <div><label>장소</label>
          <select value={loc} onChange={e => setLoc(e.target.value)} disabled={stage === "S"}>
            <option value="HQ">본사</option>
            <option value="SITE">현장</option>
          </select>
        </div>
      </div>
      <div className="actions">
        <button className="btn primary sm" onClick={save} disabled={busy}>저장</button>
        <button className="btn sm" onClick={() => setOpen(false)} disabled={busy}>취소</button>
      </div>
      {msg && <div className={"msg " + msg.t}>{msg.s}</div>}
    </div>
  );
}
