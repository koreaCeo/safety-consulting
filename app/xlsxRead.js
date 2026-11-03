// 평가지표 엑셀(Check list 시트)에서 G열(점수)·I열(현황)·J열(개선대책)을 읽음
// 브라우저에서 동작 (JSZip + DOMParser). 테스트 때는 Parser를 넘겨받음.
import JSZip from "jszip";

const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS("*", tag));
const clean = s => String(s ?? "").replace(/_x000D_/g, "").replace(/\r\n?/g, "\n").trim();

function textOf(si) {
  // 서식이 섞인 글자(<r><t>)는 이어 붙이고, 읽는 법 표기(<rPh>)는 뺌
  return byTag(si, "t").filter(t => {
    for (let p = t.parentNode; p && p !== si; p = p.parentNode) if (p.localName === "rPh") return false;
    return true;
  }).map(t => t.textContent).join("");
}

function resolve(target) {
  const t = target.replace(/^\//, "");
  return t.startsWith("xl/") ? t : "xl/" + t.replace(/^\.\//, "");
}

async function readSheets(buf, Parser) {
  const P = Parser || DOMParser;
  const zip = await JSZip.loadAsync(buf);
  const xml = async p => { const f = zip.file(p); return f ? new P().parseFromString(await f.async("string"), "application/xml") : null; };
  const wb = await xml("xl/workbook.xml");
  const rels = await xml("xl/_rels/workbook.xml.rels");
  if (!wb || !rels) throw new Error("엑셀(xlsx) 파일이 아닙니다.");
  const relMap = {};
  for (const r of byTag(rels, "Relationship")) relMap[r.getAttribute("Id")] = r.getAttribute("Target");
  const ssDoc = await xml("xl/sharedStrings.xml");
  const ss = ssDoc ? byTag(ssDoc, "si").map(textOf) : [];
  const sheets = byTag(wb, "sheet").map(s => {
    const rid = s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    return { name: s.getAttribute("name") || "", path: relMap[rid] ? resolve(relMap[rid]) : null };
  });
  async function cells(path) {
    const doc = await xml(path);
    if (!doc) return {};
    const m = {};
    for (const c of byTag(doc, "c")) {
      const ref = c.getAttribute("r"); if (!ref) continue;
      const t = c.getAttribute("t");
      const v = byTag(c, "v")[0]?.textContent;
      let val;
      if (t === "s") val = ss[Number(v)] ?? "";
      else if (t === "inlineStr") val = byTag(c, "is").map(textOf).join("");
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else if (t === "str" || t === "e") val = v ?? "";
      else if (v != null && v !== "" && !isNaN(Number(v))) val = String(Math.round(Number(v) * 100) / 100);
      else val = v ?? "";
      m[ref] = clean(val);
    }
    return m;
  }
  return { sheets, cells };
}

// rowsToRead: 읽을 행 번호 목록 (평가지표 4~71행)
export async function readChecklistXlsx(buf, rowsToRead, Parser) {
  const { sheets, cells } = await readSheets(buf, Parser);
  const isList = n => n.replace(/\s/g, "").toLowerCase().includes("checklist");
  const order = [...sheets.filter(s => isList(s.name)), ...sheets.filter(s => !isList(s.name))];
  let found = null;
  for (const s of order) {
    if (!s.path) continue;
    const m = await cells(s.path);
    if ((m.I3 || "").includes("현황") && (m.J3 || "").includes("개선")) { found = { s, m }; break; }
  }
  if (!found) throw new Error("평가지표 Check list 시트(I3 '현황 및 문제점', J3 '개선대책')를 찾지 못했습니다.");
  const { m } = found;
  const rows = {};
  let n = 0, total = 0;
  for (const r of rowsToRead) {
    const g = m["G" + r] || "", i = m["I" + r] || "", j = m["J" + r] || "";
    rows[r] = { g, i, j };
    if (g || i || j) n++;
    if (r !== 4 && g !== "" && !isNaN(Number(g))) total += Number(g);
  }
  return { rows, n, total: Math.round(total * 100) / 100, sheet: found.s.name };
}
