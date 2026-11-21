// app.js — 控制台原型（无框架、无构建）
const TABS = [
  ['overview', '状态'],
  ['search', '检索'],
  ['review', '待审'],
  ['audit', '审计'],
  ['settings', '设置'],
]

const $ = (sel) => document.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const api = (p) => fetch(p).then((r) => r.json())

function route() {
  const hash = location.hash.replace(/^#/, '') || '/overview'
  const [, name = 'overview', arg] = hash.split('/')
  return { name, arg }
}

function renderTabs(active) {
  $('#tabs').innerHTML = TABS.map(
    ([id, label]) => `<a href="#/${id}" class="${id === active ? 'active' : ''}">${label}</a>`,
  ).join('')
}

async function boot() {
  const meta = await api('/api/meta')
  $('#authority').textContent = meta.authority
  $('#chain').innerHTML = meta.chain.ok
    ? `<span class="dot ok"></span>链一致 · ${meta.chain.lines} 行`
    : `<span class="dot bad"></span>断链`

  const { name } = route()
  renderTabs(name)
  try {
    if (name === 'search') return await viewSearch()
    if (name === 'record') return await viewRecord(location.hash.split('/')[2])
    if (name === 'audit') return await viewAudit()
    if (name === 'review') return await viewReview()
    if (name === 'settings') return await viewSettings()
    return await viewOverview()
  } catch (error) {
    $('#view').innerHTML = `
    <section class="card">
      <div class="card-head"><div><h2>这个页面没渲染出来</h2><p>原因写在下边，不白屏。</p></div></div>
      <div class="card-body"><div class="content mono small">${esc(error?.message ?? error)}</div></div>
      <div class="card-foot"><span>${esc(location.hash || '#/overview')}</span><span>按 R 重新加载</span></div>
    </section>`
    console.error(error)
  }
}

window.addEventListener('error', (e) => {
  const view = document.getElementById('view')
  if (view && !view.innerHTML.trim()) {
    view.innerHTML = `<section class="card"><div class="card-body"><div class="content mono small">${esc(e.message)}</div></div></section>`
  }
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' && e.ctrlKey) location.reload()
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    const q = document.getElementById('q')
    if (q) { e.preventDefault(); q.focus() } else { location.hash = '#/search' }
  }
})

// ---------- 总览 ----------
async function viewOverview() {
  const d = await api('/api/overview')
  const max = Math.max(...d.layers.map((l) => l.n), 1)
  $('#view').innerHTML = `
  <section class="card">
    <div class="kpis">
      <div>
        <div class="kpi-label"><span class="dot ok"></span>记录</div>
        <div class="kpi-value">${d.records}</div>
        <div class="kpi-sub">FTS ${d.fts} 行</div>
      </div>
      <div>
        <div class="kpi-label"><span class="dot ${d.pending ? 'warn' : 'idle'}"></span>待审</div>
        <div class="kpi-value">${d.pending}</div>
        <div class="kpi-sub">隔离 ${d.quarantined}</div>
      </div>
      <div>
        <div class="kpi-label"><span class="dot ${d.sLevel ? 'bad' : 'idle'}"></span>S 级</div>
        <div class="kpi-value">${d.sLevel}</div>
        <div class="kpi-sub">默认不进检索</div>
      </div>
      <div>
        <div class="kpi-label"><span class="dot ok"></span>导入</div>
        <div class="kpi-value">${d.legacy}</div>
        <div class="kpi-sub">legacy_import</div>
      </div>
      <div>
        <div class="kpi-label"><span class="dot ok"></span>体积 / 快照</div>
        <div class="kpi-value">${d.sizeKb} KB</div>
        <div class="kpi-sub">快照 ${d.snapshots} 份</div>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <div>
        <h2>健康</h2>
        <p>权威源、审计链与最近操作。任何一行都能点开回放。</p>
      </div>
      <div class="actions"><button class="btn sm" onclick="location.reload()">刷新</button></div>
    </div>
    <div class="card-body">
      <div style="display:flex;gap:28px;flex-wrap:wrap;font-size:13px;color:var(--ink-2)">
        <div><span class="dot ok"></span>权威源 <b>${esc(d.authority)}</b></div>
        <div><span class="dot ${d.chain.ok ? 'ok' : 'bad'}"></span>哈希链 ${d.chain.ok ? '一致' : '断链'} · ${d.chain.lines} 行 / ${d.chain.files} 文件</div>
        <div><span class="dot ok"></span>索引一致</div>
      </div>
      <div style="margin-top:20px">
        ${d.layers.map((l) => `
          <div class="layer-row">
            <span class="name">${esc(l.layer)}</span>
            <span class="bar"><span style="width:${Math.round((l.n / max) * 100)}%"></span></span>
            <span class="num">${l.n}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="card-foot"><span>数据目录 D:\\001\\CH001\\dsh-memory-data</span><span>本地 · 只监听 127.0.0.1</span></div>
  </section>

  <section class="card">
    <div class="card-head"><div><h2>最近操作</h2><p>点任意一行进入审计回放。</p></div></div>
    <div class="rows">
      ${d.recent.map((r) => `
        <div class="row">
          <span class="mono">#${r.seq}</span>
          <span class="op">${esc(r.op)}</span>
          <span class="txt">${esc(r.label)}</span>
          <span class="muted small">${r.at}</span>
          <a class="go" href="#/audit">回放</a>
        </div>`).join('')}
    </div>
  </section>`
}

// ---------- 检索 ----------
async function viewSearch() {
  $('#view').innerHTML = `
  <section class="card">
    <div class="searchbar">
      <input id="q" placeholder="搜记忆：关键词、命令、路径…（按 / 聚焦）" value="风扇阈值" />
      <button class="btn primary" id="go">搜索</button>
    </div>
    <div class="split">
      <div id="hits"><div class="empty">按回车搜索</div></div>
      <aside class="filters">
        <h3>过滤</h3>
        <label><input type="checkbox" checked /> L1 共享层</label>
        <label><input type="checkbox" checked /> L2 场景私有</label>
        <label><input type="checkbox" checked /> L3 个人层</label>
        <label style="margin-top:10px"><input type="checkbox" /> 包含 S 级</label>
        <div class="small muted" style="margin-top:12px">S 级默认不返回，勾选后仍需在详情页二次确认。</div>
      </aside>
    </div>
  </section>`
  const run = async () => {
    const q = $('#q').value.trim()
    if (!q) return
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`)
    $('#hits').innerHTML = data.results.length === 0
      ? `<div class="empty"><strong>没有命中</strong>换个词，或放宽过滤器。</div>`
      : `<div class="card-body" style="padding:10px 18px;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--ink-3)">${data.results.length} 条命中 · 耗时 ${data.ms} ms</div>` +
        data.results.map((r) => `
        <div class="hit">
          <div class="title">${esc(r.preview)}</div>
          <div class="meta">
            <span class="badge info">${esc(r.layer)}</span>
            <span class="badge ${r.sad_level === 'S' ? 'danger' : ''}">${esc(r.sad_level)} 级</span>
            <span class="badge">${esc(r.trust_level)}</span>
            <span>α ${r.alpha ?? '—'} · β ${r.beta ?? '—'}</span>
            <span>召回 ${r.hits} 次</span>
            <span class="mono">${esc(r.record_id.slice(0, 8))}…</span>
            <a class="go" href="#/record/${encodeURIComponent(r.record_id)}" style="margin-left:auto;color:var(--info)">打开</a>
          </div>
          ${r.caveat ? `<div class="caveat">${esc(r.caveat)}</div>` : ''}
        </div>`).join('')
  }
  $('#go').onclick = run
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') run() }
  run()
}

// ---------- 记录详情 ----------
async function viewRecord(id) {
  const r = await api(`/api/record/${encodeURIComponent(id || '')}`)
  const masked = r.sad_level === 'S'
  $('#view').innerHTML = `
  <section class="card">
    <div class="card-head">
      <div>
        <h2>记录 <span class="mono small muted">${esc(r.record_id)}</span></h2>
        <p>${esc(r.layer)} · ${esc(r.sad_level)} 级 · ${esc(r.trust_level)} · ${esc(r.status)}</p>
      </div>
      <div class="actions"><button class="btn sm">复制 ID</button></div>
    </div>
    <div class="card-body">
      ${masked
        ? `<div class="masked">
             <div style="margin-bottom:10px"><span class="badge danger">S 级</span> 正文默认隐藏，避免截图外泄。</div>
             <div style="white-space:pre-wrap" class="content">${esc(r.content_masked)}</div>
             <button class="btn sm" style="margin-top:12px">我确认，本地查看</button>
           </div>`
        : `<div class="content">${esc(r.content || '')}</div>`}
      <dl class="meta-grid">
        <div><dt>来源</dt><dd>${esc(r.source_channel)}</dd></div>
        <div><dt>原始位置</dt><dd class="mono small">${esc(r.legacy_ref || '—')}</dd></div>
        <div><dt>创建</dt><dd>${esc(r.created_at)}</dd></div>
        <div><dt>α / β</dt><dd>${r.alpha ?? '—'} / ${r.beta ?? '—'}</dd></div>
        <div><dt>哈希前缀</dt><dd class="mono small">${esc(r.record_id.slice(0, 12))}…</dd></div>
        <div><dt>版本</dt><dd>rev 1</dd></div>
      </dl>
    </div>
    <div class="card-foot"><span>所有修改都会新增一条 rev，旧版本永久可读</span><span>${esc(r.origin)}</span></div>
  </section>

  <section class="card">
    <div class="card-head"><div><h2>这条记录的时间轴</h2><p>它被写入、被修复、被召回的每一次都在这。</p></div></div>
    <div class="card-body">
      <div class="timeline">
        ${r.timeline.map((t) => `<div class="tl-item"><span class="t">${esc(t.at)}</span><b>${esc(t.op)}</b> · ${esc(t.label)}</div>`).join('')}
      </div>
    </div>
  </section>`
}

// ---------- 审计 ----------
async function viewAudit() {
  const d = await api('/api/traces')
  $('#view').innerHTML = `
  <section class="card">
    <div class="card-head">
      <div>
        <h2>审计</h2>
        <p>追加写入、逐行哈希。改动任何一行都会让链对不上。</p>
      </div>
      <div class="actions"><button class="btn sm">全量校验</button></div>
    </div>
    <div class="card-body" style="padding:0">
      <table class="traces">
        <thead><tr><th style="width:70px">seq</th><th style="width:110px">时间</th><th style="width:120px">操作</th><th>摘要</th><th style="width:80px">耗时</th></tr></thead>
        <tbody>
        ${d.traces.map((t) => `
          <tr>
            <td class="mono">#${t.seq}</td>
            <td class="mono">${esc(t.at)}</td>
            <td><span class="op">${esc(t.op)}</span></td>
            <td>${esc(t.preview)}</td>
            <td class="mono">${t.dur} ms</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="card-foot"><span>只记 ID / 分数 / 计数 / 耗时，不记正文、不记路径</span><span>audit-202610.jsonl</span></div>
  </section>`
}

// ---------- 待审 ----------
async function viewReview() {
  $('#view').innerHTML = `
  <section class="card">
    <div class="card-head"><div><h2>待审</h2><p>疑似矛盾与隔离区会落到这里，必须人工给出口。</p></div></div>
    <div class="empty"><strong>没有待审</strong>有矛盾会被自动放到这里，通过 / 否决 / 解除隔离三选一。</div>
  </section>`
}

// ---------- 设置 ----------
async function viewSettings() {
  $('#view').innerHTML = `
  <section class="card">
    <div class="card-head"><div><h2>权威源</h2><p>切换会改变检索走向，写操作不受影响。</p></div></div>
    <div class="card-body">
      <div class="row" style="border:0;padding:0 0 10px">
        <span class="badge info">shadow</span>
        <span class="muted small">新旧并读：检索结果附带旧库对比，最安全的一档。</span>
      </div>
      <div class="row" style="border:0;padding:0 0 10px">
        <span class="badge">legacy</span>
        <span class="muted small">只读旧源：新库只写不读，适合回退期。</span>
      </div>
      <div class="row" style="border:0;padding:0">
        <span class="badge ok">new</span>
        <span class="muted small">新库为准：旧源不再参与检索。</span>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-head"><div><h2>脱敏规则</h2><p>按密文处理，原文留在原处。这里不提供“关闭脱敏”。</p></div></div>
    <div class="card-body">
      <div class="small muted" style="line-height:1.9">
        密码 / 口令 / token / 私钥 / SSH·VNC 凭据 / 手机号 / 身份证 · Markdown 表格按列<br />
        凭证密集文档（命中 ≥2 类）<b>只导指针</b>，不导正文
      </div>
    </div>
    <div class="card-foot"><span>已知盲区：无标签的自由文本、图片内文字</span><span>lib/redact.js</span></div>
  </section>`
}

window.addEventListener('hashchange', boot)
boot()
