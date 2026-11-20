#!/usr/bin/env bun
/**
 * Dựng báo cáo coverage chi tiết từ file Cobertura XML (cargo-llvm-cov, coverlet) hoặc LCOV (bun test).
 *
 * Env:
 *   COVERAGE_LCOV     đường dẫn file LCOV (.info)
 *   COVERAGE_XML      đường dẫn file Cobertura XML (bắt buộc nếu không đặt COVERAGE_LCOV)
 *   REPORT_TITLE      tiêu đề, vd "Desktop Coverage" (mặc định "Coverage")
 *   GROUP_DEPTH       số cấp thư mục dùng làm "cụm" (mặc định 2)
 *   THRESHOLD_GOOD    % line coverage coi là đủ (mặc định 80)
 *   THRESHOLD_WARN    % dưới mức này coi là thiếu (mặc định 50)
 *   MAX_FILE_ROWS     số file cần bổ sung test hiển thị trong báo cáo PR (mặc định 40)
 *   OUTPUT_MD         file markdown cho comment PR (mặc định code-coverage-results.md)
 *   GITHUB_STEP_SUMMARY / GITHUB_OUTPUT  do Actions cấp (bảng đầy đủ + percentage=...)
 */
import fs from 'node:fs'

/** line -> hits; line -> [nhánh đã chạy, tổng nhánh] */
type FileEntry = { lines: Map<string, number>; branches: Map<string, [number, number]> }
type Row = {
  file: string
  lc: number
  lt: number
  bc: number
  bt: number
  lp: number | null
  bp: number | null
}
type Group = { lc: number; lt: number; bc: number; bt: number; files: number; okFiles: number }

const env = process.env
const lcovPath = env.COVERAGE_LCOV
const xmlPath = env.COVERAGE_XML
const useLcov = Boolean(lcovPath)
const reportPath = lcovPath || xmlPath
if (!reportPath || !fs.existsSync(reportPath)) {
  console.log(
    `::error::Không tìm thấy file coverage: ${reportPath ?? '(chưa đặt COVERAGE_LCOV / COVERAGE_XML)'}`,
  )
  process.exit(1)
}
const title = env.REPORT_TITLE || 'Coverage'
const groupDepth = Math.max(1, Number(env.GROUP_DEPTH || 2))
const good = Number(env.THRESHOLD_GOOD || 80)
const warn = Number(env.THRESHOLD_WARN || 50)
const maxFileRows = Number(env.MAX_FILE_ROWS || 40)
const outputMd = env.OUTPUT_MD || 'code-coverage-results.md'

const attr = (attrs: string, name: string): string | undefined => {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? m[1] : undefined
}
const num = (v: string | undefined): number => (v === undefined || v === '' ? 0 : Number(v))

const files = new Map<string, FileEntry>()
let rootAttrs = ''

if (useLcov) {
  const lcov = fs.readFileSync(lcovPath as string, 'utf8')
  let curKey: string | null = null
  let curLines = new Map<string, number>()
  let curBranchHits = new Map<string, number>()

  const flushRecord = () => {
    if (!curKey) return
    const entry: FileEntry = files.get(curKey) || { lines: new Map(), branches: new Map() }
    for (const [ln, hits] of curLines) {
      entry.lines.set(ln, Math.max(entry.lines.get(ln) || 0, hits))
    }
    const perLineBranch = new Map<string, [number, number]>()
    for (const [brKey, hits] of curBranchHits) {
      const ln = brKey.split(':', 1)[0] as string
      const prev = perLineBranch.get(ln) || [0, 0]
      perLineBranch.set(ln, [prev[0] + (hits > 0 ? 1 : 0), prev[1] + 1])
    }
    for (const [ln, [cov, tot]] of perLineBranch) {
      const prev = entry.branches.get(ln) || [0, 0]
      entry.branches.set(ln, [Math.max(prev[0], cov), Math.max(prev[1], tot)])
    }
    files.set(curKey, entry)
    curKey = null
    curLines = new Map<string, number>()
    curBranchHits = new Map<string, number>()
  }

  for (const rawLine of lcov.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('SF:')) {
      flushRecord()
      curKey = line.slice(3).trim().replace(/\\/g, '/').replace(/^\.\//, '')
    } else if (line.startsWith('DA:') && curKey) {
      const [ln, hits] = line.slice(3).split(',')
      if (ln !== undefined && hits !== undefined) {
        curLines.set(ln, Math.max(curLines.get(ln) || 0, Number(hits) || 0))
      }
    } else if (line.startsWith('BRDA:') && curKey) {
      const [ln, blk, br, taken] = line.slice(5).split(',')
      if (ln !== undefined && blk !== undefined && br !== undefined) {
        const key = `${ln}:${blk}:${br}`
        const hits = taken && taken !== '-' ? Number(taken) || 0 : 0
        curBranchHits.set(key, Math.max(curBranchHits.get(key) || 0, hits))
      }
    } else if (line === 'end_of_record') {
      flushRecord()
    }
  }
  flushRecord()
} else {
  const xml = fs.readFileSync(xmlPath as string, 'utf8')
  rootAttrs = (xml.match(/<coverage\b([^>]*)>/) || [])[1] || ''

  // ---- đường dẫn tương đối: bỏ tiền tố <source>, chuẩn hoá dấu phân cách
  const sources = [...xml.matchAll(/<source>([^<]*)<\/source>/g)]
    .map((m) => (m[1] ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const rel = (file: string): string => {
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
  const classRe = /<class\b([^>]*)>([\s\S]*?)<\/class>/g
  const lineRe = /<line\b([^>]*)\/?>/g
  for (const [, classAttrs = '', body = ''] of xml.matchAll(classRe)) {
    const filename = attr(classAttrs, 'filename')
    if (!filename) continue
    const key = rel(filename)
    const entry: FileEntry = files.get(key) || { lines: new Map(), branches: new Map() }
    // Chỉ đọc khối <lines> cấp class (sau </methods>): dòng của <method> có thể không nằm trong
    // khối này (Vitest/istanbul) và tổng của header được tính từ khối cấp class.
    const classLines = body.split('</methods>').pop() ?? ''
    for (const [, a = ''] of classLines.matchAll(lineRe)) {
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
}

// Đường dẫn vẫn tuyệt đối (không có <source> khớp, vd reportgenerator) → bỏ thư mục cha chung.
{
  const isAbs = (f: string): boolean => f.startsWith('/') || /^[A-Za-z]:\//.test(f)
  const keys = [...files.keys()]
  if (keys.length && keys.every(isAbs)) {
    const parts = keys.map((k) => k.split('/').slice(0, -1))
    let common = parts[0] ?? []
    for (const p of parts.slice(1)) {
      let i = 0
      while (i < common.length && i < p.length && common[i] === p[i]) i++
      common = common.slice(0, i)
    }
    if (common.length) {
      const prefix = `${common.join('/')}/`
      for (const k of keys) {
        files.set(k.slice(prefix.length), files.get(k) as FileEntry)
        files.delete(k)
      }
    }
  }
}

const pct = (c: number, t: number): number | null => (t ? (c / t) * 100 : null)
const fmt = (p: number | null): string => (p === null ? '—' : `${p.toFixed(1)}%`)
const status = (p: number | null): string =>
  p === null ? '—' : p >= good ? '✅ Đủ' : p >= warn ? '⚠️ Cần thêm' : '❌ Thiếu'
const icon = (p: number | null): string => (p === null ? '⚪' : p >= good ? '🟢' : p >= warn ? '🟡' : '🔴')
const esc = (s: string): string => s.replace(/\|/g, '\\|')

const rows: Row[] = []
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
const groupOf = (file: string): string => {
  const dirs = file.split('/').slice(0, -1)
  return dirs.length ? dirs.slice(0, groupDepth).join('/') : '(gốc)'
}
const groups = new Map<string, Group>()
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
  .sort((a, b) => (a.lp ?? 0) - (b.lp ?? 0) || b.lt - b.lc - (a.lt - a.lc))
const untested = rows.filter((r) => r.lc === 0)

const groupRows = [...groups.entries()]
  .map(([name, g]) => ({ name, ...g, lp: pct(g.lc, g.lt), bp: pct(g.bc, g.bt) }))
  .sort((a, b) => (a.lp ?? 0) - (b.lp ?? 0) || a.name.localeCompare(b.name))

const branchCell = (c: number, t: number, p: number | null): string => (t ? `${fmt(p)} (${c}/${t})` : '—')
const fileRow = (r: Row): string =>
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
