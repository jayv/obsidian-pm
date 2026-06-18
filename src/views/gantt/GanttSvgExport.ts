import type { GanttGranularity, PriorityConfig, Project, StatusConfig, Task } from '../../types'
import { flattenTasks, collectAllAssignees } from '../../store/TaskTreeOps'
import { getStatusConfig, getPriorityConfig, stringToColor } from '../../utils'
import { displayName, initialsFor } from '../../ui/primitives/Avatar'
import { parsePlainDate } from '../../dates'
import { buildTimelineConfig, dateToX } from './TimelineConfig'

// ── Layout constants (base, zoom = 1) ───────────────────────────────────────
const LABEL_W = 240
const HEADER_H = 40
const ROW_H = 36
const TOOLBAR_H = 44
const BAR_PAD = 7
const RIGHT_PAD = 60
const AVATAR_R = 9
const AVATAR_STEP = 13
const AVATAR_EDGE_GAP = 3
const ACCENT = '#6c8cd5'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface RowGeom {
  task: Task
  depth: number
  /** Bar left, in timeline px at zoom 1 (relative to timeline origin). */
  barX0: number | null
  barW0: number | null
  /** Milestone diamond centre, timeline px at zoom 1. */
  msX0: number | null
  /** Dependency anchors at zoom 1. */
  inX0: number | null
  outX0: number | null
}

/**
 * Build a self-contained, interactive SVG of the Gantt chart. The embedded
 * script (active when the file is opened in a browser) supports horizontal
 * zoom, assignee filtering, and task-name search; everything is laid out at
 * zoom 1 with base coordinates in data-* attributes that the script rescales.
 */
export function buildGanttSvg(
  project: Project,
  statuses: StatusConfig[],
  priorities: PriorityConfig[],
  granularity: GanttGranularity
): string {
  const cfg = buildTimelineConfig(project.tasks, granularity, 1)
  const flat = flattenTasks(project.tasks)
  const BASE_W = cfg.totalWidth
  const dx = (d: Parameters<typeof dateToX>[1]) => dateToX(cfg, d)

  // Resolve geometry + dependency anchors per row.
  const rows: RowGeom[] = flat.map((f) => {
    const task = f.task
    const isMs = task.type === 'milestone'
    const start = parsePlainDate(task.start)
    const due = parsePlainDate(task.due)
    let barX0: number | null = null
    let barW0: number | null = null
    let msX0: number | null = null
    let inX0: number | null = null
    let outX0: number | null = null

    if (isMs) {
      const d = due ?? start
      if (d) {
        msX0 = dx(d) + cfg.dayWidth / 2
        inX0 = msX0
        outX0 = msX0
      }
    } else {
      const es = start ?? due
      if (es) {
        const ee = (due ?? es).add({ days: 1 })
        barX0 = Math.max(0, dx(es))
        barW0 = Math.max(8, Math.min(BASE_W, dx(ee)) - barX0)
        inX0 = barX0
        outX0 = barX0 + barW0
      }
    }
    return { task, depth: f.depth, barX0, barW0, msX0, inX0, outX0 }
  })

  const anchor = new Map<string, { inX0: number; outX0: number }>()
  for (const r of rows) if (r.inX0 !== null && r.outX0 !== null) anchor.set(r.task.id, { inX0: r.inX0, outX0: r.outX0 })

  const rowIndex = new Map<string, number>()
  rows.forEach((r, i) => rowIndex.set(r.task.id, i))

  // ── Grid lines (weekly) + month labels ───────────────────────────────────
  const gridParts: string[] = []
  const headerParts: string[] = []
  for (let i = 0; i <= cfg.totalDays; i++) {
    const d = cfg.startDate.add({ days: i })
    if (d.dayOfWeek === 1) {
      const x0 = i * cfg.dayWidth
      gridParts.push(
        `<line class="vline" data-x0="${x0}" x1="${LABEL_W + x0}" y1="${HEADER_H}" x2="${LABEL_W + x0}" y2="${HEADER_H}"/>`
      )
    }
    if (d.day === 1) {
      const x0 = i * cfg.dayWidth
      const label = d.toLocaleString(undefined, { month: 'short', year: '2-digit' })
      headerParts.push(`<text class="mlabel" data-x0="${x0 + 4}" x="${LABEL_W + x0 + 4}" y="26">${esc(label)}</text>`)
    }
  }

  // ── Rows ──────────────────────────────────────────────────────────────────
  const rowParts: string[] = []
  const labelMaxChars = Math.max(6, Math.floor((LABEL_W - 14) / 7))
  rows.forEach((r, i) => {
    const task = r.task
    const lx = 8 + r.depth * 16
    const status = getStatusConfig(statuses, task.status)
    const fill = status?.color ?? ACCENT
    const priority = getPriorityConfig(priorities, task.priority)?.color
    const y = HEADER_H + i * ROW_H
    const cy = ROW_H / 2
    const barY = BAR_PAD
    const barH = ROW_H - BAR_PAD * 2

    const name = displayName(task.title)
    const labelText = name.length > labelMaxChars ? name.slice(0, labelMaxChars - 1) + '…' : name

    const parts: string[] = []
    parts.push(`<text class="rlabel" x="${lx}" y="${cy}">${esc(labelText)}</text>`)

    if (r.msX0 !== null) {
      // Milestone diamond — positioned by group translate so it never distorts.
      const s = 9
      parts.push(
        `<g class="ms" data-x0="${r.msX0}" data-ty="${cy}" transform="translate(${LABEL_W + r.msX0},${cy})">` +
          `<polygon points="0,${-s} ${s},0 0,${s} ${-s},0" fill="#8fd9ad"/></g>`
      )
    } else if (r.barX0 !== null && r.barW0 !== null) {
      const bx = LABEL_W + r.barX0
      parts.push(
        `<rect class="bar" data-x0="${r.barX0}" data-w0="${r.barW0}" x="${bx}" y="${barY}" width="${r.barW0}" height="${barH}" rx="6" fill="${fill}" fill-opacity="0.4"/>`
      )
      if (task.progress > 0) {
        const pw = (task.progress / 100) * r.barW0
        parts.push(
          `<rect class="prog" data-x0="${r.barX0}" data-w0="${pw}" x="${bx}" y="${barY}" width="${pw}" height="${barH}" rx="6" fill="${fill}" fill-opacity="0.9"/>`
        )
      }
      if (priority) {
        parts.push(
          `<rect class="pout" data-x0="${r.barX0}" data-w0="${r.barW0}" x="${bx}" y="${barY}" width="${r.barW0}" height="${barH}" rx="6" fill="none" stroke="${priority}" stroke-width="2"/>`
        )
      }
      // Avatars, right-aligned inside the bar, in a translate-only group.
      if (task.assignees.length) {
        const rightX0 = r.barX0 + r.barW0
        const names = task.assignees.map(displayName)
        const shown = Math.min(3, names.length)
        const overflow = names.length - shown
        const av: string[] = []
        for (let k = shown - 1; k >= 0; k--) {
          const acx = -AVATAR_R - AVATAR_EDGE_GAP - k * AVATAR_STEP
          const isOver = overflow > 0 && k === shown - 1
          const aFill = isOver ? '#555b66' : stringToColor(names[k])
          const aText = isOver ? `+${overflow + 1}` : initialsFor(names[k])
          av.push(`<circle cx="${acx}" cy="0" r="${AVATAR_R}" fill="${aFill}" stroke="rgba(255,255,255,0.7)"/>`)
          av.push(`<text class="av" x="${acx}" y="0">${esc(aText)}</text>`)
        }
        parts.push(
          `<g class="avg" data-x0="${rightX0}" data-ty="${cy}" transform="translate(${LABEL_W + rightX0},${cy})">${av.join('')}</g>`
        )
      }
    }

    rowParts.push(
      `<g class="row" data-id="${esc(task.id)}" data-title="${esc(name)}" data-assignees="${esc(JSON.stringify(task.assignees.map(displayName)))}" transform="translate(0,${y})">${parts.join('')}</g>`
    )
  })

  // ── Dependency curves ──────────────────────────────────────────────────────
  const depParts: string[] = []
  for (const r of rows) {
    const succ = r.task
    if (!succ.dependencies?.length) continue
    const to = anchor.get(succ.id)
    const toRow = rowIndex.get(succ.id)
    if (!to || toRow === undefined) continue
    for (const depId of succ.dependencies) {
      const from = anchor.get(depId)
      const fromRow = rowIndex.get(depId)
      if (!from || fromRow === undefined) continue
      const fx = LABEL_W + from.outX0
      const tx = LABEL_W + to.inX0
      const fy = HEADER_H + fromRow * ROW_H + ROW_H / 2
      const ty = HEADER_H + toRow * ROW_H + ROW_H / 2
      const mx = (fx + tx) / 2
      depParts.push(
        `<g class="dep" data-from="${esc(depId)}" data-to="${esc(succ.id)}" data-fx0="${from.outX0}" data-tx0="${to.inX0}">` +
          `<path class="depline" d="M ${fx} ${fy} C ${mx} ${fy}, ${mx} ${ty}, ${tx} ${ty}" marker-end="url(#pm-ah)"/></g>`
      )
    }
  }

  // ── Toolbar (HTML via foreignObject) ───────────────────────────────────────
  // Assignee filter is a row of toggleable avatar chips.
  const assigneeChips = collectAllAssignees(project.tasks)
    .map((a) => {
      const name = displayName(a)
      return `<div class="avf" data-name="${esc(name)}" title="${esc(name)}" style="background:${stringToColor(name)}">${esc(initialsFor(name))}</div>`
    })
    .join('')

  const initialH = TOOLBAR_H + HEADER_H + rows.length * ROW_H + 8
  const initialW = LABEL_W + BASE_W + RIGHT_PAD

  const css = `
    text { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; fill: #d0d0d8; }
    .bg { fill: #1e1e23; }
    .panel { fill: #26262d; }
    .vline { stroke: rgba(255,255,255,0.06); stroke-width: 1; }
    .mlabel { font-size: 11px; font-weight: 600; fill: #9aa0ad; }
    .rlabel { font-size: 12px; dominant-baseline: middle; }
    .av { font-size: 9px; font-weight: 700; fill: #fff; text-anchor: middle; dominant-baseline: central; }
    .depline { fill: none; stroke: ${ACCENT}; stroke-width: 1.3; stroke-dasharray: 4 3; opacity: 0.55; }
    .pm-ah { fill: ${ACCENT}; opacity: 0.7; }
    .tb { display:flex; align-items:center; gap:8px; height:100%; padding:0 12px; box-sizing:border-box;
          font-family:-apple-system,"Segoe UI",Roboto,sans-serif; color:#d0d0d8; background:#26262d; }
    .tb input, .tb select { background:#1e1e23; color:#d0d0d8; border:1px solid #3a3a44; border-radius:5px;
          padding:4px 8px; font-size:12px; }
    .tb input { width:200px; }
    .tb button { background:#1e1e23; color:#d0d0d8; border:1px solid #3a3a44; border-radius:5px;
          width:28px; height:26px; cursor:pointer; font-size:14px; }
    .tb button:hover { background:#33333c; }
    .tb .sp { flex:1; }
    .tb .hint { font-size:11px; color:#777e8c; }
    .tb .avfrow { display:flex; gap:4px; align-items:center; max-width:46%; overflow-x:auto; }
    .avf { width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center;
          font-size:9px; font-weight:700; color:#fff; cursor:pointer; opacity:0.5; border:2px solid transparent;
          flex:0 0 auto; user-select:none; box-sizing:border-box; }
    .avf:hover { opacity:0.8; }
    .avf.on { opacity:1; border-color:#fff; }`

  const cfgJson = JSON.stringify({ LABEL_W, HEADER_H, ROW_H, TOOLBAR_H, BASE_W, RIGHT_PAD })

  const script = `
var svg=document.querySelector('svg');var C=${cfgJson};var zoom=1;
var rows=[].slice.call(svg.querySelectorAll('.row'));
var deps=[].slice.call(svg.querySelectorAll('.dep'));
var search=document.getElementById('pm-search');
var chips=[].slice.call(svg.querySelectorAll('.avf'));
var selected=[];
function sx(x0){return C.LABEL_W + x0*zoom;}
function layout(){
  var xs=svg.querySelectorAll('[data-x0]');
  for(var i=0;i<xs.length;i++){var el=xs[i];var x0=parseFloat(el.getAttribute('data-x0'));var X=sx(x0);var tag=el.tagName.toLowerCase();
    if(tag==='line'){el.setAttribute('x1',X);el.setAttribute('x2',X);}
    else if(tag==='rect'){el.setAttribute('x',X);var w0=el.getAttribute('data-w0');if(w0!==null)el.setAttribute('width',parseFloat(w0)*zoom);}
    else if(tag==='text'){el.setAttribute('x',X);}
    else if(tag==='g'){el.setAttribute('transform','translate('+X+','+el.getAttribute('data-ty')+')');}}
  var idx=0,pos={};
  for(var r=0;r<rows.length;r++){var row=rows[r];
    if(row.getAttribute('data-hidden')==='1'){row.style.display='none';continue;}
    row.style.display='';var y=C.HEADER_H+idx*C.ROW_H;row.setAttribute('transform','translate(0,'+y+')');
    pos[row.getAttribute('data-id')]=y;idx++;}
  var contentH=C.HEADER_H+idx*C.ROW_H;
  var vlines=svg.querySelectorAll('.vline');for(var v=0;v<vlines.length;v++){vlines[v].setAttribute('y2',contentH);}
  for(var d=0;d<deps.length;d++){var dep=deps[d];var f=pos[dep.getAttribute('data-from')],t=pos[dep.getAttribute('data-to')];
    if(f==null||t==null){dep.style.display='none';continue;}
    dep.style.display='';var fx=sx(parseFloat(dep.getAttribute('data-fx0'))),tx=sx(parseFloat(dep.getAttribute('data-tx0')));
    var fy=f+C.ROW_H/2,ty=t+C.ROW_H/2,mx=(fx+tx)/2;
    dep.querySelector('.depline').setAttribute('d','M '+fx+' '+fy+' C '+mx+' '+fy+', '+mx+' '+ty+', '+tx+' '+ty);}
  var w=C.LABEL_W+C.BASE_W*zoom+C.RIGHT_PAD,h=C.TOOLBAR_H+contentH+8;
  svg.setAttribute('width',w);svg.setAttribute('height',h);svg.setAttribute('viewBox','0 0 '+w+' '+h);
}
function filt(){var q=(search.value||'').toLowerCase();
  for(var r=0;r<rows.length;r++){var row=rows[r];
    var okT=!q||(row.getAttribute('data-title')||'').toLowerCase().indexOf(q)>=0;
    var as=[];try{as=JSON.parse(row.getAttribute('data-assignees')||'[]');}catch(e){}
    var okA=selected.length===0;
    if(!okA){for(var k=0;k<as.length;k++){if(selected.indexOf(as[k])>=0){okA=true;break;}}}
    row.setAttribute('data-hidden',(okT&&okA)?'0':'1');}
  layout();}
search.addEventListener('input',filt);
for(var ci=0;ci<chips.length;ci++){(function(c){c.addEventListener('click',function(){
  c.classList.toggle('on');selected=[];
  for(var j=0;j<chips.length;j++){if(chips[j].classList.contains('on'))selected.push(chips[j].getAttribute('data-name'));}
  filt();});})(chips[ci]);}
document.getElementById('pm-zin').addEventListener('click',function(){zoom=Math.min(6,zoom*1.25);layout();});
document.getElementById('pm-zout').addEventListener('click',function(){zoom=Math.max(0.25,zoom/1.25);layout();});
document.getElementById('pm-zreset').addEventListener('click',function(){zoom=1;layout();});
layout();`

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${initialW}" height="${initialH}" viewBox="0 0 ${initialW} ${initialH}" font-family="sans-serif">
<style>${css}</style>
<defs>
  <marker id="pm-ah" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path class="pm-ah" d="M0,0 L0,6 L8,3 z"/></marker>
</defs>
<rect class="bg" x="0" y="0" width="100%" height="100%"/>
<g transform="translate(0,${TOOLBAR_H})">
  <rect class="panel" x="0" y="0" width="${LABEL_W}" height="100%"/>
  <rect class="panel" x="0" y="0" width="100%" height="${HEADER_H}"/>
  <g class="grid">${gridParts.join('')}</g>
  <g class="header">${headerParts.join('')}</g>
  <g class="deps">${depParts.join('')}</g>
  <g class="rows">${rowParts.join('')}</g>
</g>
<foreignObject x="0" y="0" width="${initialW}" height="${TOOLBAR_H}">
  <body xmlns="http://www.w3.org/1999/xhtml" style="margin:0">
    <div class="tb">
      <input id="pm-search" type="text" placeholder="Search tasks…"/>
      <div class="avfrow" id="pm-assignees">${assigneeChips}</div>
      <button id="pm-zout" title="Zoom out">−</button>
      <button id="pm-zreset" title="Reset zoom">1×</button>
      <button id="pm-zin" title="Zoom in">+</button>
      <span class="sp"></span>
      <span class="hint">${esc(project.title)} · open in a browser for zoom/filter</span>
    </div>
  </body>
</foreignObject>
<script type="text/ecmascript"><![CDATA[${script}]]></script>
</svg>`
}
