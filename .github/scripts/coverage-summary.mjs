#!/usr/bin/env node
/**
 * Dựng báo cáo coverage chi tiết từ file Cobertura XML (cargo-llvm-cov, Vitest, coverlet/reportgenerator).
 *
 * Env:
 *   COVERAGE_XML      đường dẫn file Cobertura (bắt buộc)
 *   REPORT_TITLE      tiêu đề, vd "Desktop Coverage" (mặc định "Coverage")
 *   GROUP_DEPTH       số cấp thư mục dùng làm "cụm" (mặc định 2)
 *   THRESHOLD_GOOD    % line coverage coi là đủ (mặc định 80)
 *   THRESHOLD_WARN    % dưới mức này coi là thiếu (mặc định 50)
 *   MAX_FILE_ROWS     số file cần bổ sung test hiển thị trong báo cáo PR (mặc định 40)
 *   OUTPUT_MD         file markdown cho comment PR (mặc định code-coverage-results.md)
 *   GITHUB_STEP_SUMMARY / GITHUB_OUTPUT  do Actions cấp (bảng đầy đủ + percentage=...)
 */
import fs from 'node:fs'

const env = process.env
const xmlPath = env.COVERAGE_XML
if (!xmlPath || !fs.existsSync(xmlPath)) {
  console.log(`::error::Không tìm thấy file coverage: ${xmlPath ?? '(chưa đặt COVERAGE_XML)'}`)
  process.exit(1)
}
const title = env.REPORT_TITLE || 'Coverage'
const groupDepth = Math.max(1, Number(env.GROUP_DEPTH || 2))
const good = Number(env.THRESHOLD_GOOD || 80)
const warn = Number(env.THRESHOLD_WARN || 50)
const maxFileRows = Number(env.MAX_FILE_ROWS || 40)
const outputMd = env.OUTPUT_MD || 'code-coverage-results.md'

const xml = fs.readFileSync(xmlPath, 'utf8')

// ---- tiện ích đọc thuộc tính (thứ tự thuộc tính tuỳ công cụ)
const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? m[1] : undefined
}
const rootAttrs = (xml.match(/<coverage\b([^>]*)>/) || [])[1] || ''
const num = (v) => (v === undefined || v === '' ? 0 : Number(v))

// ---- đường dẫn tương đối: bỏ tiền tố <source>, chuẩn hoá dấu phân cách
const sources = [...xml.matchAll(/<source>([^<]*)<\/source>/g)]
  .map((m) => m[1].trim().replace(/\\/g, '/').replace(/\/+$/, ''))
  .filter(Boolean)
  .sort((a, b) => b.length - a.length)
const rel = (file) => {
  let f = file.replace(/\\/g, '/')
  for (const s of sources) {
    if (f.startsWith(`${s}/`)) {
      f = f.slice(s.length + 1)
      break
    }
  }
  return f.replace(/^\.\//, '')
}

// ---- gom số liệu theo file: line -> hits (max), line -> [covered, total] nhánh (max)
const files = new Map()
const classRe = /<class\b([^>]*)>([\s\S]*?)<\/class>/g
const lineRe = /<line\b([^>]*)\/?>/g
for (const [, classAttrs, body] of xml.matchAll(classRe)) {
  const filename = attr(classAttrs, 'filename')
  if (!filename) continue
  const key = rel(filename)
  const entry = files.get(key) || { lines: new Map(), branches: new Map() }
  // Chỉ đọc khối <lines> cấp class (sau </methods>): dòng của <method> có thể không nằm trong
  // khối này (Vitest/istanbul) và tổng của header được tính từ khối cấp class.
  const classLines = body.split('</methods>').pop()
  for (const [, a] of classLines.matchAll(lineRe)) {
    const n = attr(a, 'number')
    const hits = attr(a, 'hits')
    if (n === undefined || hits === undefined) continue
    entry.lines.set(n, Math.max(entry.lines.get(n) || 0, Number(hits)))
    if (attr(a, 'branch') === 'true') {
      const cc = attr(a, 'condition-coverage') || ''
      const m = cc.match(/\((\d+)\/(\d+)\)/)
      if (m) {
        const prev = entry.branches.get(n) || [0, 0]
        entry.branches.set(n, [Math.max(prev[0], Number(m[1])), Math.max(prev[1], Number(m[2]))])
      }
    }
  }
  files.set(key, entry)
}

// Đường dẫn vẫn tuyệt đối (không có <source> khớp, vd reportgenerator) → bỏ thư mục cha chung.
{
  const isAbs = (f) => f.startsWith('/') || /^[A-Za-z]:\//.test(f)
  const keys = [...files.keys()]
  if (keys.length && keys.every(isAbs)) {
    const parts = keys.map((k) => k.split('/').slice(0, -1))
    let common = parts[0]
    for (const p of parts.slice(1)) {
      let i = 0
      while (i < common.length && i < p.length && common[i] === p[i]) i++
      common = common.slice(0, i)
    }
    if (common.length) {
      const prefix = `${common.join('/')}/`
      for (const k of keys) {
        files.set(k.slice(prefix.length), files.get(k))
        files.delete(k)
      }
    }
  }
}

const pct = (c, t) => (t ? (c / t) * 100 : null)
const fmt = (p) => (p === null ? '—' : `${p.toFixed(1)}%`)
const status = (p) =>
  p === null ? '—' : p >= good ? '✅ Đủ' : p >= warn ? '⚠️ Cần thêm' : '❌ Thiếu'
const icon = (p) => (p === null ? '⚪' : p >= good ? '🟢' : p >= warn ? '🟡' : '🔴')
const esc = (s) => s.replace(/\|/g, '\\|')

const rows = []
for (const [file, e] of files) {
  if (!e.lines.size) continue
  let lc = 0
  for (const h of e.lines.values()) if (h > 0) lc++
  let bc = 0
  let bt = 0
  for (const [c, t] of e.branches.values()) {
    bc += c
    bt += t
  }
  rows.push({ file, lc, lt: e.lines.size, bc, bt, lp: pct(lc, e.lines.size), bp: pct(bc, bt) })
}
rows.sort((a, b) => a.file.localeCompare(b.file))

// ---- cụm = GROUP_DEPTH cấp thư mục đầu (file nằm ở gốc → "(gốc)")
const groupOf = (file) => {
  const dirs = file.split('/').slice(0, -1)
  return dirs.length ? dirs.slice(0, groupDepth).join('/') : '(gốc)'
}
const groups = new Map()
for (const r of rows) {
  const g = groups.get(groupOf(r.file)) || { lc: 0, lt: 0, bc: 0, bt: 0, files: 0, okFiles: 0 }
  g.lc += r.lc
  g.lt += r.lt
  g.bc += r.bc
  g.bt += r.bt
  g.files++
  if (r.lp !== null && r.lp >= good) g.okFiles++
  groups.set(groupOf(r.file), g)
}

// ---- tổng: ưu tiên số trong header, nếu thiếu thì cộng từ file
let linesCovered = num(attr(rootAttrs, 'lines-covered'))
let linesValid = num(attr(rootAttrs, 'lines-valid'))
if (!linesValid) {
  linesCovered = rows.reduce((s, r) => s + r.lc, 0)
  linesValid = rows.reduce((s, r) => s + r.lt, 0)
}
let branchesCovered = num(attr(rootAttrs, 'branches-covered'))
let branchesValid = num(attr(rootAttrs, 'branches-valid'))
if (!branchesValid) {
  branchesCovered = rows.reduce((s, r) => s + r.bc, 0)
  branchesValid = rows.reduce((s, r) => s + r.bt, 0)
}
const lineP = pct(linesCovered, linesValid) ?? 0
const branchP = pct(branchesCovered, branchesValid)
const okFiles = rows.filter((r) => r.lp !== null && r.lp >= good).length
const weak = rows
  .filter((r) => r.lp !== null && r.lp < good)
  .sort((a, b) => a.lp - b.lp || b.lt - b.lc - (a.lt - a.lc))
const untested = rows.filter((r) => r.lc === 0)

const groupRows = [...groups.entries()]
  .map(([name, g]) => ({ name, ...g, lp: pct(g.lc, g.lt), bp: pct(g.bc, g.bt) }))
  .sort((a, b) => (a.lp ?? 0) - (b.lp ?? 0) || a.name.localeCompare(b.name))

const branchCell = (c, t, p) => (t ? `${fmt(p)} (${c}/${t})` : '—')
const fileRow = (r) =>
  `| \`${esc(r.file)}\` | ${status(r.lp)} | ${fmt(r.lp)} (${r.lc}/${r.lt}) | ${branchCell(r.bc, r.bt, r.bp)} | ${r.lt - r.lc} |`

const header = [
  `### ${title} — ${icon(lineP)} ${fmt(lineP)}`,
  '',
  '| Chỉ số | Coverage | Đã test / Tổng |',
  '|--------|----------|----------------|',
  `| Line | ${icon(lineP)} ${fmt(lineP)} | ${linesCovered} / ${linesValid} |`,
  branchesValid
    ? `| Branch | ${icon(branchP)} ${fmt(branchP)} | ${branchesCovered} / ${branchesValid} |`
    : '| Branch | ⚪ chưa đo | — |',
  `| File đạt ngưỡng (≥ ${good}% line) | ${icon(pct(okFiles, rows.length))} ${okFiles} / ${rows.length} | ${untested.length} file chưa có test (0%) |`,
  '',
  `> Ngưỡng theo line coverage: ✅ **Đủ** ≥ ${good}% · ⚠️ **Cần thêm** ${warn}–${good - 1}% · ❌ **Thiếu** < ${warn}%`,
  '',
  `#### Theo cụm (${groupRows.length} cụm, yếu nhất trước)`,
  '',
  '| Cụm | Trạng thái | Line | Branch | File đủ / tổng |',
  '|-----|-----------|------|--------|----------------|',
  ...groupRows.map(
    (g) =>
      `| \`${esc(g.name)}\` | ${status(g.lp)} | ${fmt(g.lp)} (${g.lc}/${g.lt}) | ${branchCell(g.bc, g.bt, g.bp)} | ${g.okFiles} / ${g.files} |`,
  ),
  '',
]

const fileHeader = [
  '| File | Trạng thái | Line | Branch | Dòng chưa test |',
  '|------|-----------|------|--------|----------------|',
]
const weakSection = weak.length
  ? [
      `#### File cần bổ sung test (${weak.length} file dưới ${good}%, thấp nhất trước)`,
      '',
      ...fileHeader,
      ...weak.slice(0, maxFileRows).map(fileRow),
      ...(weak.length > maxFileRows
        ? ['', `…và ${weak.length - maxFileRows} file khác — xem bảng đầy đủ trong Job Summary của run.`]
        : []),
      '',
    ]
  : [`#### ✅ Tất cả ${rows.length} file đều đạt ngưỡng ${good}%`, '']

const pr = [...header, ...weakSection].join('\n')
const full = [
  ...header,
  ...weakSection,
  `<details><summary>Tất cả ${rows.length} file</summary>`,
  '',
  ...fileHeader,
  ...rows.map(fileRow),
  '',
  '</details>',
  '',
].join('\n')

fs.writeFileSync(outputMd, `${pr}\n`)
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${full}\n`)
if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `percentage=${lineP.toFixed(1)}\n`)
console.log(
  `${title}: line ${fmt(lineP)}, branch ${branchesValid ? fmt(branchP) : 'chưa đo'} — ${groupRows.length} cụm, ${rows.length} file (${okFiles} đạt ≥ ${good}%, ${untested.length} file 0%)`,
)
if (linesValid > 0 && rows.length === 0) {
  console.log('::warning::Cobertura có số liệu nhưng không đọc được file nào — kiểm tra lại định dạng <class>/<line>.')
}
