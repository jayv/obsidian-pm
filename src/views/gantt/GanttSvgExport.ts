import type { GanttGranularity, PriorityConfig, Project, StatusConfig, Task } from '../../types'
import { flattenTasks, collectAllAssignees } from '../../store/TaskTreeOps'
import { getStatusConfig, getPriorityConfig, stringToColor } from '../../utils'
import { displayName, initialsFor } from '../../ui/primitives/Avatar'
import { parsePlainDate, today } from '../../dates'
import { buildTimelineConfig, dateToX } from './TimelineConfig'

// ── Layout constants (base, zoom = 1) ───────────────────────────────────────
const LABEL_W = 240
const TOOLBAR_H = 44
const HEADER_H = 56
const CHART_TOP = TOOLBAR_H + HEADER_H
const PILL_CY = TOOLBAR_H + 13 // milestone pill band
const ROW_H = 32
const BAR_PAD = 7
const RIGHT_PAD = 80
const AVATAR_R = 8
const AVATAR_STEP = 13
const AVATAR_EDGE_GAP = 3
const DAY_MIN = 16 // min effective day width (px) to show day numbers
const MILESTONE_COLOR = '#8fd9ad'
const ACCENT = '#6c8cd5'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface RowGeom {
  task: Task
  depth: number
  isSummary: boolean
  barX0: number | null
  barW0: number | null
  msX0: number | null
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
    const isSummary = !isMs && task.subtasks.length > 0 && barX0 !== null
    return { task, depth: f.depth, isSummary, barX0, barW0, msX0, inX0, outX0 }
  })

  const anchor = new Map<string, { inX0: number; outX0: number }>()
  for (const r of rows) if (r.inX0 !== null && r.outX0 !== null) anchor.set(r.task.id, { inX0: r.inX0, outX0: r.outX0 })

  const rowIndex = new Map<string, number>()
  rows.forEach((r, i) => rowIndex.set(r.task.id, i))

  // ── Header: month band (top) + day numbers (bottom) + weekly gridlines ─────
  const gridParts: string[] = []
  const monthParts: string[] = []
  const dayParts: string[] = []
  const dlineParts: string[] = [] // per-day vertical borders
  const weekendParts: string[] = [] // weekend column shading
  const showDays = cfg.totalDays <= 1500
  for (let i = 0; i <= cfg.totalDays; i++) {
    const d = cfg.startDate.add({ days: i })
    const x0 = i * cfg.dayWidth
    if (d.dayOfWeek === 1) {
      gridParts.push(
        `<line class="vline" data-x0="${x0}" x1="${LABEL_W + x0}" y1="${CHART_TOP}" x2="${LABEL_W + x0}" y2="${CHART_TOP}"/>`
      )
    }
    if (d.day === 1) {
      const label = d.toLocaleString(undefined, { month: 'short', year: '2-digit' })
      monthParts.push(
        `<text class="mlabel" data-x0="${x0 + 5}" x="${LABEL_W + x0 + 5}" y="${TOOLBAR_H + 32}">${esc(label)}</text>`
      )
    }
    if (showDays && i < cfg.totalDays) {
      const cxx = x0 + cfg.dayWidth / 2
      dayParts.push(`<text class="dlabel" data-x0="${cxx}" x="${LABEL_W + cxx}" y="${TOOLBAR_H + 50}">${d.day}</text>`)
      dlineParts.push(
        `<line class="dline" data-x0="${x0}" x1="${LABEL_W + x0}" y1="${CHART_TOP}" x2="${LABEL_W + x0}" y2="${CHART_TOP}"/>`
      )
      if (d.dayOfWeek === 6 || d.dayOfWeek === 7) {
        weekendParts.push(
          `<rect class="wkrect" data-x0="${x0}" data-w0="${cfg.dayWidth}" x="${LABEL_W + x0}" y="${CHART_TOP}" width="${cfg.dayWidth}" height="0"/>`
        )
      }
    }
  }

  // Today marker line (scales with zoom, full chart height).
  const todayX0 = dx(today())
  const todayLine =
    todayX0 >= 0 && todayX0 <= BASE_W
      ? `<line class="todayline" data-x0="${todayX0}" x1="${LABEL_W + todayX0}" y1="${CHART_TOP}" x2="${LABEL_W + todayX0}" y2="${CHART_TOP}"/>`
      : ''

  // ── Rows ──────────────────────────────────────────────────────────────────
  const rowParts: string[] = []
  const msPillParts: string[] = [] // header pills (sticky)
  const msLineParts: string[] = [] // vertical connector lines (chart body)
  const labelMaxChars = Math.max(6, Math.floor((LABEL_W - 14) / 7))
  rows.forEach((r, i) => {
    const task = r.task
    const lx = 8 + r.depth * 16
    const status = getStatusConfig(statuses, task.status)
    const fill = status?.color ?? ACCENT
    const priority = getPriorityConfig(priorities, task.priority)?.color
    const y = CHART_TOP + i * ROW_H
    const cy = ROW_H / 2
    const barY = BAR_PAD
    const barH = ROW_H - BAR_PAD * 2
    const hasKids = i + 1 < rows.length && rows[i + 1].depth > r.depth

    const name = displayName(task.title)
    const labelMax = Math.max(4, labelMaxChars - r.depth * 2)
    const labelText = name.length > labelMax ? name.slice(0, labelMax - 1) + '…' : name

    const parts: string[] = []
    if (hasKids) {
      parts.push(`<text class="ctoggle" data-id="${esc(task.id)}" x="${lx}" y="${cy}">▾</text>`)
    }
    parts.push(`<text class="rlabel" x="${lx + 14}" y="${cy}">${esc(labelText)}</text>`)

    if (r.msX0 !== null) {
      // Milestone diamond on its row; pill goes in the sticky header and a
      // dashed connector line spans the chart (collected below).
      const s = 9
      parts.push(
        `<g class="ms" data-x0="${r.msX0}" data-ty="${cy}" transform="translate(${LABEL_W + r.msX0},${cy})">` +
          `<polygon points="0,${-s} ${s},0 0,${s} ${-s},0" fill="${MILESTONE_COLOR}"/></g>`
      )
      msLineParts.push(
        `<line class="msline" data-x0="${r.msX0}" x1="${LABEL_W + r.msX0}" y1="${CHART_TOP}" x2="${LABEL_W + r.msX0}" y2="${CHART_TOP}"/>`
      )
      const pw = name.length * 6.2 + 16
      msPillParts.push(
        `<g class="mspill" data-x0="${r.msX0}" data-ty="${PILL_CY}" transform="translate(${LABEL_W + r.msX0},${PILL_CY})">` +
          `<rect x="${-pw / 2}" y="-9" width="${pw}" height="18" rx="9" fill="${MILESTONE_COLOR}" fill-opacity="0.95"/>` +
          `<text class="mspilltext" x="0" y="0">${esc(name)}</text></g>`
      )
    } else if (r.barX0 !== null && r.barW0 !== null) {
      const bx = LABEL_W + r.barX0
      const rightX0 = r.barX0 + r.barW0
      if (r.isSummary) {
        // Summary (parent): thin bar with downward slanted legs at start/end.
        const TH = 4
        const LEG = 9
        const legW = Math.min(6, r.barW0 / 2)
        parts.push(
          `<rect class="sbar" data-x0="${r.barX0}" data-w0="${r.barW0}" x="${bx}" y="${barY}" width="${r.barW0}" height="${TH}" fill="${fill}" fill-opacity="0.9"/>`
        )
        parts.push(
          `<g class="scap" data-x0="${r.barX0}" data-ty="${barY}" transform="translate(${bx},${barY})"><polygon points="0,0 0,${LEG} ${legW},${TH}" fill="${fill}" fill-opacity="0.9"/></g>`
        )
        parts.push(
          `<g class="scap" data-x0="${rightX0}" data-ty="${barY}" transform="translate(${LABEL_W + rightX0},${barY})"><polygon points="0,0 0,${LEG} ${-legW},${TH}" fill="${fill}" fill-opacity="0.9"/></g>`
        )
      } else {
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
        if (task.assignees.length) {
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
      // Task name to the right of the bar (full, never truncated).
      parts.push(
        `<text class="blabel" data-x0="${rightX0}" dx="8" x="${LABEL_W + rightX0}" y="${cy}">${esc(name)}</text>`
      )
    }

    const msAttr = r.msX0 !== null ? ' data-ms="1"' : ''
    rowParts.push(
      `<g class="row"${msAttr} data-id="${esc(task.id)}" data-depth="${r.depth}" data-title="${esc(name)}" data-assignees="${esc(JSON.stringify(task.assignees.map(displayName)))}" transform="translate(0,${y})">${parts.join('')}</g>`
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
      const fy = CHART_TOP + fromRow * ROW_H + ROW_H / 2
      const ty = CHART_TOP + toRow * ROW_H + ROW_H / 2
      const mx = (fx + tx) / 2
      depParts.push(
        `<g class="dep" data-from="${esc(depId)}" data-to="${esc(succ.id)}" data-fx0="${from.outX0}" data-tx0="${to.inX0}">` +
          `<path class="depline" d="M ${fx} ${fy} C ${mx} ${fy}, ${mx} ${ty}, ${tx} ${ty}" marker-end="url(#pm-ah)"/></g>`
      )
    }
  }

  // ── Toolbar (HTML via foreignObject) — assignee filter = avatar chips ──────
  const assigneeChips = collectAllAssignees(project.tasks)
    .map((a) => {
      const name = displayName(a)
      return `<div class="avf" data-name="${esc(name)}" title="${esc(name)}" style="background:${stringToColor(name)}">${esc(initialsFor(name))}</div>`
    })
    .join('')

  const initialH = CHART_TOP + rows.length * ROW_H + 8
  const initialW = LABEL_W + BASE_W + RIGHT_PAD

  const css = `
    text { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; fill: #d0d0d8; }
    .bg { fill: #1e1e23; }
    .panel { fill: #26262d; }
    .vline { stroke: rgba(255,255,255,0.10); stroke-width: 1; }
    .dline { stroke: rgba(255,255,255,0.04); stroke-width: 1; }
    .wkrect { fill: rgba(255,255,255,0.035); }
    .msline { stroke: ${MILESTONE_COLOR}; stroke-width: 1.5; stroke-dasharray: 4 4; opacity: 0.55; }
    .todayline { stroke: #d86b6b; stroke-width: 1.5; stroke-dasharray: 5 4; opacity: 0.8; }
    .mspilltext { font-size: 10px; font-weight: 700; fill: #0b3d24; text-anchor: middle; dominant-baseline: central; }
    .mlabel { font-size: 11px; font-weight: 600; fill: #c2c7d0; }
    .dlabel { font-size: 9px; fill: #8b909c; text-anchor: middle; }
    .rlabel { font-size: 12px; dominant-baseline: middle; }
    .ctoggle { font-size: 10px; dominant-baseline: middle; fill: #8b909c; cursor: pointer; }
    .ctoggle:hover { fill: #d0d0d8; }
    .blabel { font-size: 11px; dominant-baseline: middle; fill: #b9bdc7; }
    .mslabel { font-size: 11px; font-weight: 600; dominant-baseline: middle; fill: ${MILESTONE_COLOR}; }
    .hdiv { stroke: #3a3a44; stroke-width: 1; }
    .av { font-size: 9px; font-weight: 700; fill: #fff; text-anchor: middle; dominant-baseline: central; }
    .depline { fill: none; stroke: ${ACCENT}; stroke-width: 1.3; stroke-dasharray: 4 3; opacity: 0.55; }
    .pm-ah { fill: ${ACCENT}; opacity: 0.7; }
    .tb { display:flex; align-items:center; gap:8px; height:100%; padding:0 12px; box-sizing:border-box;
          font-family:-apple-system,"Segoe UI",Roboto,sans-serif; color:#d0d0d8; background:#26262d;
          border-bottom:1px solid #3a3a44; }
    .tb input { background:#1e1e23; color:#d0d0d8; border:1px solid #3a3a44; border-radius:5px; padding:4px 8px; font-size:12px; width:200px; }
    .tb button { background:#1e1e23; color:#d0d0d8; border:1px solid #3a3a44; border-radius:5px; width:28px; height:26px; cursor:pointer; font-size:14px; }
    .tb button:hover { background:#33333c; }
    .tb .sp { flex:1; }
    .tb .hint { font-size:11px; color:#777e8c; }
    .tb .avfrow { display:flex; gap:4px; align-items:center; max-width:46%; overflow-x:auto; }
    .avf { width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center;
          font-size:9px; font-weight:700; color:#fff; cursor:pointer; opacity:0.5; border:2px solid transparent;
          flex:0 0 auto; user-select:none; box-sizing:border-box; }
    .avf:hover { opacity:0.8; }
    .avf.on { opacity:1; border-color:#fff; }`

  const cfgJson = JSON.stringify({
    LABEL_W,
    ROW_H,
    CHART_TOP,
    TOOLBAR_H,
    BASE_W,
    RIGHT_PAD,
    DAY: cfg.dayWidth,
    DAY_MIN
  })

  const script = `
var svg=document.querySelector('svg');var C=${cfgJson};var zoom=1;
var rows=[].slice.call(svg.querySelectorAll('.row'));
var deps=[].slice.call(svg.querySelectorAll('.dep'));
var search=document.getElementById('pm-search');
var chips=[].slice.call(svg.querySelectorAll('.avf'));
var header=document.getElementById('pm-header');
var toolbar=document.getElementById('pm-toolbar');
var days=document.getElementById('pm-days');
var toggles=[].slice.call(svg.querySelectorAll('.ctoggle'));
var selected=[];var collapsed={};
function sx(x0){return C.LABEL_W + x0*zoom;}
function recollapse(){var hideBelow=Infinity;
  for(var r=0;r<rows.length;r++){var row=rows[r];var dep=parseInt(row.getAttribute('data-depth')||'0',10);
    if(dep>hideBelow){row.setAttribute('data-chid','1');}
    else{row.setAttribute('data-chid','0');hideBelow=Infinity;if(collapsed[row.getAttribute('data-id')])hideBelow=dep;}}}
function layout(){
  var xs=svg.querySelectorAll('[data-x0]');
  for(var i=0;i<xs.length;i++){var el=xs[i];var x0=parseFloat(el.getAttribute('data-x0'));var X=sx(x0);var tag=el.tagName.toLowerCase();
    if(tag==='line'){el.setAttribute('x1',X);el.setAttribute('x2',X);}
    else if(tag==='rect'){el.setAttribute('x',X);var w0=el.getAttribute('data-w0');if(w0!==null)el.setAttribute('width',parseFloat(w0)*zoom);}
    else if(tag==='text'){el.setAttribute('x',X);}
    else if(tag==='g'){el.setAttribute('transform','translate('+X+','+el.getAttribute('data-ty')+')');}}
  if(days){days.style.display=(C.DAY*zoom>=C.DAY_MIN)?'':'none';}
  var detail=C.DAY*zoom>=6;
  var dl=document.getElementById('pm-dlines');if(dl)dl.style.display=detail?'':'none';
  var wk=document.getElementById('pm-weekends');if(wk)wk.style.display=detail?'':'none';
  var idx=0,pos={};
  for(var r=0;r<rows.length;r++){var row=rows[r];
    if(row.getAttribute('data-fhid')==='1'||row.getAttribute('data-chid')==='1'){row.style.display='none';continue;}
    row.style.display='';var y=C.CHART_TOP+idx*C.ROW_H;row.setAttribute('transform','translate(0,'+y+')');
    pos[row.getAttribute('data-id')]=y;idx++;}
  var contentH=C.CHART_TOP+idx*C.ROW_H;
  var vlines=svg.querySelectorAll('.vline,.dline,.msline,.todayline');for(var v=0;v<vlines.length;v++){vlines[v].setAttribute('y2',contentH);}
  var wr=svg.querySelectorAll('.wkrect');for(var w2=0;w2<wr.length;w2++){wr[w2].setAttribute('height',contentH-C.CHART_TOP);}
  for(var d=0;d<deps.length;d++){var dep=deps[d];var f=pos[dep.getAttribute('data-from')],t=pos[dep.getAttribute('data-to')];
    if(f==null||t==null){dep.style.display='none';continue;}
    dep.style.display='';var fx=sx(parseFloat(dep.getAttribute('data-fx0'))),tx=sx(parseFloat(dep.getAttribute('data-tx0')));
    var fy=f+C.ROW_H/2,ty=t+C.ROW_H/2,mx=(fx+tx)/2;
    dep.querySelector('.depline').setAttribute('d','M '+fx+' '+fy+' C '+mx+' '+fy+', '+mx+' '+ty+', '+tx+' '+ty);}
  var w=C.LABEL_W+C.BASE_W*zoom+C.RIGHT_PAD,h=contentH+8;
  svg.setAttribute('width',w);svg.setAttribute('height',h);svg.setAttribute('viewBox','0 0 '+w+' '+h);
}
function filt(){var q=(search.value||'').toLowerCase();
  for(var r=0;r<rows.length;r++){var row=rows[r];
    if(row.getAttribute('data-ms')==='1'){row.setAttribute('data-fhid','0');continue;}
    var okT=!q||(row.getAttribute('data-title')||'').toLowerCase().indexOf(q)>=0;
    var as=[];try{as=JSON.parse(row.getAttribute('data-assignees')||'[]');}catch(e){}
    var okA=selected.length===0;
    if(!okA){for(var k=0;k<as.length;k++){if(selected.indexOf(as[k])>=0){okA=true;break;}}}
    row.setAttribute('data-fhid',(okT&&okA)?'0':'1');}
  layout();}
function sticky(){var y=window.pageYOffset||document.documentElement.scrollTop||0;
  if(header)header.setAttribute('transform','translate(0,'+y+')');
  if(toolbar)toolbar.setAttribute('y',y);}
search.addEventListener('input',filt);
for(var ci=0;ci<chips.length;ci++){(function(c){c.addEventListener('click',function(){
  c.classList.toggle('on');selected=[];
  for(var j=0;j<chips.length;j++){if(chips[j].classList.contains('on'))selected.push(chips[j].getAttribute('data-name'));}
  filt();});})(chips[ci]);}
for(var ti=0;ti<toggles.length;ti++){(function(t){t.addEventListener('click',function(){
  var id=t.getAttribute('data-id');collapsed[id]=!collapsed[id];t.textContent=collapsed[id]?'▸':'▾';
  recollapse();layout();});})(toggles[ti]);}
document.getElementById('pm-zin').addEventListener('click',function(){zoom=Math.min(6,zoom*1.25);layout();});
document.getElementById('pm-zout').addEventListener('click',function(){zoom=Math.max(0.25,zoom/1.25);layout();});
document.getElementById('pm-zreset').addEventListener('click',function(){zoom=1;layout();});
window.addEventListener('scroll',sticky);
recollapse();layout();sticky();`

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${initialW}" height="${initialH}" viewBox="0 0 ${initialW} ${initialH}" font-family="sans-serif">
<style>${css}</style>
<defs>
  <marker id="pm-ah" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path class="pm-ah" d="M0,0 L0,6 L8,3 z"/></marker>
</defs>
<rect class="bg" x="0" y="0" width="100%" height="100%"/>
<rect class="panel" x="0" y="0" width="${LABEL_W}" height="100%"/>
<g id="pm-weekends">${weekendParts.join('')}</g>
<g id="pm-dlines">${dlineParts.join('')}</g>
<g class="grid">${gridParts.join('')}</g>
<g class="mslines">${msLineParts.join('')}</g>
<g class="today">${todayLine}</g>
<g class="deps">${depParts.join('')}</g>
<g class="rows">${rowParts.join('')}</g>
<g id="pm-header">
  <rect class="panel" x="0" y="${TOOLBAR_H}" width="100%" height="${HEADER_H}"/>
  <text class="mlabel" x="8" y="${TOOLBAR_H + 32}">Task</text>
  <g class="months">${monthParts.join('')}</g>
  <g id="pm-days">${dayParts.join('')}</g>
  <g class="mspills">${msPillParts.join('')}</g>
  <line class="hdiv" x1="0" y1="${CHART_TOP}" x2="100%" y2="${CHART_TOP}"/>
</g>
<foreignObject id="pm-toolbar" x="0" y="0" width="${initialW}" height="${TOOLBAR_H}">
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
