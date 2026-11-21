// dsh-memory-core · Client bundle（P4）
// 设置页「记忆底座」：总览 / 检索 / 待审 / 审计。
// 数据只走 RPC（/memory-core），UI 不直接读库；写操作只有审核。
window.__ModuleLoader__.load({
  id: 'dsh-sixlayer-memory',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var name = 'dsh-sixlayer-memory'
    var inject = ['slots', 'connection']

    var CSS = [
      '.mc-root{display:flex;flex-direction:column;gap:14px;padding:4px 0 28px;font-size:13px;line-height:1.6}',
      '.mc-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsh-border,rgba(127,127,127,.25));padding-bottom:8px}',
      '.mc-tab{border:1px solid transparent;border-radius:999px;padding:5px 14px;background:transparent;color:inherit;cursor:pointer;font-size:13px}',
      '.mc-tab:hover{background:rgba(127,127,127,.1)}',
      '.mc-tab-on{border-color:var(--dsh-border,rgba(127,127,127,.35));background:rgba(127,127,127,.14);font-weight:600}',
      '.mc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}',
      '.mc-card{border:1px solid var(--dsh-border,rgba(127,127,127,.22));border-radius:10px;padding:10px 12px}',
      '.mc-k{opacity:.6;font-size:12px}',
      '.mc-v{font-size:19px;font-weight:650;line-height:1.3}',
      '.mc-ok{color:var(--dsh-success,#37a86b)}.mc-warn{color:var(--dsh-warning,#c98a24)}.mc-err{color:var(--dsh-danger,#c0392b)}',
      '.mc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.mc-input{flex:1;min-width:180px;border:1px solid var(--dsh-border,rgba(127,127,127,.35));border-radius:8px;padding:7px 10px;background:transparent;color:inherit;font:inherit}',
      '.mc-btn{border:1px solid var(--dsh-border,rgba(127,127,127,.35));border-radius:999px;padding:5px 14px;background:transparent;color:inherit;cursor:pointer}',
      '.mc-btn:hover{background:rgba(127,127,127,.12)}',
      '.mc-btn[disabled]{opacity:.45;cursor:default}',
      '.mc-list{border:1px solid var(--dsh-border,rgba(127,127,127,.22));border-radius:10px;overflow:hidden}',
      '.mc-item{padding:9px 12px;border-bottom:1px solid rgba(127,127,127,.14);cursor:pointer}',
      '.mc-item:last-child{border-bottom:none}',
      '.mc-item:hover{background:rgba(127,127,127,.09)}',
      '.mc-meta{opacity:.65;font-size:12px}',
      '.mc-bar{height:8px;border-radius:4px;background:rgba(127,127,127,.2);overflow:hidden;margin-top:4px}',
      '.mc-bar>i{display:block;height:100%;background:var(--dsh-accent,#4b7bec)}',
      '.mc-pre{margin:0;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsh-border,rgba(127,127,127,.22));border-radius:10px;padding:10px;font-size:12px}',
      '.mc-empty{opacity:.6;padding:18px 4px}',
      '.mc-banner{border-radius:10px;padding:8px 12px;border:1px solid var(--dsh-danger,#c0392b)}',
      '.mc-tag{font-size:11px;border:1px solid var(--dsh-border,rgba(127,127,127,.3));border-radius:6px;padding:1px 6px;margin-left:6px}',
    ].join('\n')

    function h(tag, props) {
      var children = [].slice.call(arguments, 2)
      return React.createElement.apply(React, [tag, props].concat(children))
    }

    /**
     * 一条记录 → 给人看的三段：标题 / 一句人话 / 小标签（类别 + 时间）。
     * 宿主返回的 display 是"人话"来源；没有就退回摘要，保证旧数据也能显示。
     */
    function dispOf(row) {
      var d = (row && row.display) || {}
      return {
        title: d.title || (row && (row.summary || row.snippet)) || (row && row.record_id) || '（空）',
        plain: d.plain || '',
        meta: [d.kind, d.when].filter(Boolean).join(' · '),
      }
    }

    /** 待审原因 → 人话。 */
    function reasonOf(code) {
      var map = {
        'unverified-source': '来源没验证过（不是你自己敲的字）',
        'contradiction-suspect': '这条和已有记忆可能冲突',
        'quarantined': '内容里有可疑指令，先隔离',
      }
      return map[String(code || '')] || '需要你看一眼'
    }

    /** 详情卡：一条记忆的全部信息（人话在上，原始正文与记录号在下）。 */
    function DetailCard(props) {
      var d = props.detail
      if (!d) return null
      var dp = dispOf(d)
      var facts = [
        ['记的是', dp.meta || '—'],
        ['层级', d.layer || '—'],
        ['分级', d.sad_level || '—'],
        ['信任', d.trust_level || '—'],
        ['来源', d.source_channel || '—'],
        ['重要度', d.alpha == null || d.alpha === null ? '未评分' : Number(d.alpha).toFixed(2)],
      ]
      return h('div', { className: 'mc-card', style: { marginTop: '10px' } },
        h('div', { className: 'mc-row', style: { justifyContent: 'space-between', alignItems: 'flex-start' } },
          h('div', { style: { fontWeight: 600, fontSize: '15px' } }, dp.title),
          props.onClose ? h('button', { className: 'mc-btn', onClick: props.onClose }, '关闭') : null),
        dp.plain ? h('div', { className: 'mc-meta', style: { marginTop: '2px' } }, dp.plain) : null,
        h('div', { className: 'mc-grid', style: { marginTop: '8px' } }, facts.map(function (kv) {
          return h('div', { key: kv[0] },
            h('div', { className: 'mc-k' }, kv[0]),
            h('div', null, String(kv[1])))
        })),
        (d.tags && d.tags.length) ? h('div', { className: 'mc-row', style: { marginTop: '8px' } }, d.tags.map(function (t) {
          return h('span', { key: t, className: 'mc-tag' }, t)
        })) : null,
        d.denied
          ? h('div', { className: 'mc-banner', style: { marginTop: '8px' } }, d.reason || '这条需要授权才能看正文')
          : h('pre', { className: 'mc-pre', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, d.content || d.summary || ''),
        h('div', { className: 'mc-meta', style: { marginTop: '6px', opacity: '.55', fontSize: '11px' } }, '记录号 ' + (d.record_id || '—')),
        (d.neighbors && d.neighbors.length) ? h('div', { style: { marginTop: '10px' } },
          h('div', { className: 'mc-k' }, '相关记忆（' + d.neighbors.length + '）'),
          d.neighbors.map(function (n) {
            return h('div', {
              key: n.record_id, className: 'mc-meta', style: { cursor: 'pointer', marginTop: '3px' },
              onClick: function () { if (props.onOpen) props.onOpen(n.record_id) },
            }, '· ' + n.title + (n.reasons && n.reasons.length ? '（' + n.reasons.join('、') + '）' : ''))
          })) : null)
    }

    /** 列表一行：标题 + 人话 + 小标签，不露 record_id。 */
    function MemRow(props) {
      var d = dispOf(props.row)
      return h('div', { className: 'mc-item', onClick: props.onClick, style: props.style },
        h('div', { style: { fontWeight: 600 } }, d.title),
        d.plain ? h('div', { className: 'mc-meta', style: { marginTop: '2px' } }, d.plain) : null,
        d.meta ? h('div', { className: 'mc-meta', style: { marginTop: '2px', opacity: '.55', fontSize: '11px' } }, d.meta) : null,
        props.children || null)
    }

    function useRpc(rpc) {
      return React.useCallback(
        function (endpoint, payload) {
          return rpc.call('/memory-core', endpoint, payload || {}).then(function (res) {
            if (!res || res.ok === false) {
              var msg = res && res.error && res.error.message ? res.error.message : 'RPC 调用失败'
              throw new Error(msg)
            }
            return res.value
          })
        },
        [rpc],
      )
    }

    function Kpi(props) {
      return h('div', { className: 'mc-card', title: props.title || '' },
        h('div', { className: 'mc-k' }, props.label),
        h('div', { className: 'mc-v ' + (props.tone || '') }, String(props.value)))
    }

    function Overview(props) {
      var jump = props.onJump || function () {}
      var s = props.status
      if (!s) return h('div', { className: 'mc-empty' }, '加载中…')
      var layers = s.byLayer || []
      var max = layers.reduce(function (m, x) { return Math.max(m, x.n) }, 1)
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-grid' },
          h(Kpi, { label: '记录', value: s.records }),
          h(Kpi, { label: '待审', value: s.pending, tone: s.pending > 20 ? 'mc-warn' : '' }),
          h(Kpi, { label: 'S 级', value: s.sLevel }),
          h(Kpi, { label: 'FTS 行', value: s.fts }),
          h(Kpi, { label: '审计', value: s.audit && s.audit.ok ? '一致' : '异常', tone: s.audit && s.audit.ok ? 'mc-ok' : 'mc-err' }),
          h(Kpi, { label: '权威源', value: s.authority })),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k', style: { marginBottom: '6px' } }, '分层分布'),
          layers.length === 0 ? h('div', { className: 'mc-empty' }, '还没有记忆。第一次写入后这里会出现。') :
            layers.map(function (x) {
              return h('div', { key: x.layer, style: { marginBottom: '6px' } },
                h('div', { className: 'mc-row' },
                  h('span', null, x.layer),
                  h('span', { className: 'mc-meta' }, String(x.n))),
                h('div', { className: 'mc-bar' }, h('i', { style: { width: Math.round((x.n / max) * 100) + '%' } })))
            })),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k', style: { marginBottom: '6px' } }, '最近操作'),
          (s.recent || []).length === 0 ? h('div', { className: 'mc-empty' }, '（暂无记录）') :
            h('div', { className: 'mc-list' }, (s.recent || []).map(function (t, i) {
              return h('div', { key: (t.trace_id || i), className: 'mc-item', style: { cursor: 'default' } },
                h('div', { className: 'mc-row' },
                  h('span', { className: 'mc-tag' }, t.op),
                  h('span', { className: 'mc-meta' }, String(t.at || '').replace('T', ' ').slice(0, 19)),
                  h('span', { className: 'mc-meta' }, t.query_preview || (t.hits ? (t.hits.length + ' 命中') : ''))))
            })))),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k', style: { marginBottom: '6px' } }, '更新说明'),
          h('div', { className: 'mc-meta' }, 'v1.5.2 · 所有分类都有「安装」；没有安装链接时给明确提示'),
          h('div', { className: 'mc-meta' }, 'v1.5.1 · GitHub 无根清单时按仓库地址搜 npm 包；新增「复制安装链接」；修 onProgress 崩溃'),
          h('div', { className: 'mc-meta' }, 'v1.5.0 · 图查询：edges 表 + BFS 邻域/扩散'),
          h('div', { className: 'mc-meta' }, 'v1.4.0 · 情绪日报/周报落盘、尖峰注入提示、主动提醒'),
          h('div', { className: 'mc-meta' }, 'v1.3.0 · 情绪事件表、QQ 采集、观测页情绪卡片')),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k', style: { marginBottom: '6px' } }, '页签功能（点一下跳过去）'),
          [['search', '检索', '全文搜记忆，点开看正文'],
           ['review', '待审', '未验证来源的写入，审核后才进正式库'],
           ['handoff', '交接', '场景交接：上次做到哪、下一步是什么'],
           ['tasks', '派单', '多 agent 任务台账（派给谁、进度、回执）'],
           ['observe', '观测', '体量/分层/情绪分布/今日情绪事件'],
           ['timeline', '时间轴', '按日期看情绪变化与当天记忆'],
           ['parts', '零件', '插件/技能/MCP 零件库：搜索、安装、卸载'],
           ['security', '安全', '已装插件的静态安全扫描'],
           ['audit', '审计', '记录仪链校验与注入回放']].map(function (x) {
            return h('div', {
              key: x[0], className: 'mc-meta', style: { cursor: 'pointer', padding: '1px 0' },
              onClick: function () { jump(x[0]) },
            }, '→ ' + x[1] + ' · ' + x[2])
          })),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k', style: { marginBottom: '6px' } }, '记忆导图'),
          ['L1 闪存（会话内）', 'L2 情景（项目事实 / 决策）', 'L3 长期（指针 / 结论）', 'L4 知识', 'L5 沉淀', 'L6 归档（降层留痕）'].map(function (line, i) {
            return h('div', {
              key: i, className: 'mc-meta',
              style: { cursor: 'pointer', fontFamily: 'ui-monospace, monospace', paddingLeft: (i * 14) + 'px' },
              onClick: function () { jump('search') },
            }, (i === 0 ? '' : '└─ ') + line)
          }),
          h('div', { className: 'mc-meta', style: { marginTop: '4px' } }, '点任一层跳到检索；层级之间靠标签/同批次连边，命令 mem_graph_view 看邻域。'))
    }

    function TimelineView(props) {
      var [data, setData] = React.useState(null)
      var [days, setDays] = React.useState(7)
      var [neighbor, setNeighbor] = React.useState(null)
      function showNeighbors(id) {
        props.call('graph/view', { record_id: id, hops: 1 })
          .then(function (v) { setNeighbor({ id: id, data: v }) })
          .catch(function (e) { props.onError(e.message) })
      }
      var LABEL = { neutral: '中性', positive: '正面', negative: '负面', urgent: '紧急' }
      React.useEffect(function () {
        props.call('timeline', { days: days })
          .then(function (v) { setData(v) })
          .catch(function (e) { props.onError(e.message) })
      }, [days])
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-row', style: { gap: '6px' } },
          h('span', { className: 'mc-k' }, '时间轴'),
          [7, 14, 30].map(function (d) {
            return h('button', { key: d, className: 'mc-tab' + (days === d ? ' mc-tab-on' : ''), onClick: function () { setDays(d) } }, '近 ' + d + ' 天')
          })),
        data && data.groups.length ? h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k', style: { marginBottom: '4px' } }, '负面趋势（按天）'),
          h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '36px' } },
            data.groups.slice().reverse().map(function (g) {
              var total = g.affect.length || 1
              var ratio = (g.counts.negative + g.counts.urgent) / total
              return h('div', {
                key: g.date, title: g.date + ' 负面 ' + Math.round(ratio * 100) + '%',
                style: {
                  width: '16px', height: Math.max(4, Math.round(ratio * 34)) + 'px',
                  background: ratio >= 0.5 ? 'var(--dsh-error, #e5484d)' : 'var(--dsh-accent, #4d8bf5)',
                  borderRadius: '2px', opacity: 0.9,
                },
              })
            }))) : null,
        !data ? h('div', { className: 'mc-empty' }, '加载中…') :
          data.groups.length === 0 ? h('div', { className: 'mc-empty' }, '这段时间还没有记录。') :
          data.groups.map(function (g) {
            return h('div', { key: g.date, className: 'mc-card' },
              h('div', { className: 'mc-k', style: { marginBottom: '4px' } }, g.date + ' · 情绪 ' + g.affect.length + ' 条 · 记忆 ' + g.memories.length + ' 条'),
              g.affect.length ? h('div', { className: 'mc-meta' }, '情绪') : null,
              g.affect.map(function (a, i) {
                return h('div', { key: 'a' + i, className: 'mc-row' },
                  h('span', { className: 'mc-tag' }, a.time + ' ' + (a.labelCn || LABEL[a.label] || a.label)),
                  h('span', { className: 'mc-meta' }, a.excerpt))
              }),
              g.memories.length ? h('div', { className: 'mc-meta', style: { marginTop: '4px' } }, '记忆') : null,
              g.memories.map(function (m, i) {
                return h('div', {
                  key: 'm' + i, className: 'mc-row', style: { cursor: 'pointer' },
                  title: '点一下看这条记忆和谁相连',
                  onClick: function () { showNeighbors(m.record_id) },
                },
                  h('span', { className: 'mc-meta' }, m.display && m.display.kind ? m.display.kind : m.layer),
                  h('span', null, m.display && m.display.title ? m.display.title : m.summary))
              }))
          }),
        neighbor ? h('div', { className: 'mc-card' },
          h('div', { className: 'mc-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'mc-k' }, neighbor.id + ' 的邻居'),
            h('button', { className: 'mc-btn', onClick: function () { setNeighbor(null) } }, '关闭')),
          (neighbor.data.nodes || []).filter(function (n) { return n.depth > 0 }).slice(0, 12).map(function (n) {
            var nd = n.display || {}
            return h('div', { key: n.record_id, className: 'mc-meta' }, (n.depth > 1 ? '隔 ' + n.depth + ' 层 · ' : '') + (nd.title || n.summary || n.record_id))
          }),
          (neighbor.data.nodes || []).filter(function (n) { return n.depth > 0 }).length === 0
            ? h('div', { className: 'mc-empty' }, '这条记忆暂时没有连边（需要共享标签或同批写入）')
            : null) : null)
    }

    function SearchView(props) {
      var [q, setQ] = React.useState('')
      var [rows, setRows] = React.useState(null)
      var [detail, setDetail] = React.useState(null)
      var [busy, setBusy] = React.useState(false)
      function run() {
        if (!q.trim()) return
        setBusy(true)
        props.call('search', { query: q, topK: 10 })
          .then(function (v) { setRows(v || []) })
          .catch(function (e) { props.onError(e.message) })
          .finally(function () { setBusy(false) })
      }
      function open(id) {
        props.call('read', { record_id: id })
          .then(function (v) { setDetail(v) })
          .catch(function (e) { props.onError(e.message) })
      }
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-row' },
          h('input', {
            className: 'mc-input', value: q, placeholder: '搜记忆…',
            onChange: function (e) { setQ(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') run() },
          }),
          h('button', { className: 'mc-btn', onClick: run, disabled: busy }, busy ? '搜索中…' : '搜索')),
        rows === null ? null : (rows.length === 0
          ? h('div', { className: 'mc-empty' }, '没有匹配的记录。')
          : h('div', { className: 'mc-list' }, rows.map(function (r) {
              return h(MemRow, { key: r.record_id, row: r, onClick: function () { open(r.record_id) } },
                r.caveat ? h('div', { className: 'mc-meta mc-warn' }, r.caveat) : null)
            }))),
        detail ? h('div', null,
          h('div', { className: 'mc-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'mc-k' }, dispOf(detail).title),
            h('button', { className: 'mc-btn', onClick: function () { setDetail(null) } }, '关闭')),
          dispOf(detail).plain ? h('div', { className: 'mc-meta', style: { margin: '2px 0 6px' } }, dispOf(detail).plain) : null,
          detail.denied
            ? h('div', { className: 'mc-banner' }, detail.reason || 'S 级记录需要显式授权')
            : h('pre', { className: 'mc-pre' }, detail.content || detail.summary || ''))
          : null)
    }

    function ReviewView(props) {
      var [rows, setRows] = React.useState(null)
      var [busy, setBusy] = React.useState(false)
      function load() {
        props.call('pending', { limit: 50 })
          .then(function (v) { setRows(v || []) })
          .catch(function (e) { props.onError(e.message) })
      }
      React.useEffect(function () { load() }, [])
      function decide(id, decision) {
        setBusy(true)
        props.call('review', { record_id: id, decision: decision })
          .then(function () { load() })
          .catch(function (e) { props.onError(e.message) })
          .finally(function () { setBusy(false) })
      }
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-k' }, '待审与隔离区的出口。批准后信任升为 trusted。'),
        rows === null ? h('div', { className: 'mc-empty' }, '加载中…') :
        rows.length === 0 ? h('div', { className: 'mc-empty' }, '没有待审记录。') :
        h('div', { className: 'mc-list' }, rows.map(function (r) {
          return h(MemRow, { key: r.record_id, row: r, style: { cursor: 'default' } },
            h('div', { className: 'mc-meta', style: { marginTop: '3px' } }, '为什么还在这：' + reasonOf(r.reason)),
            h('div', { className: 'mc-row', style: { marginTop: '6px' } },
              h('button', { className: 'mc-btn', disabled: busy, onClick: function () { decide(r.record_id, 'approve') } }, '批准'),
              h('button', { className: 'mc-btn', disabled: busy, onClick: function () { decide(r.record_id, 'release') } }, '放行'),
              h('button', { className: 'mc-btn', disabled: busy, onClick: function () { decide(r.record_id, 'reject') } }, '拒绝')))
        })))
    }

    function AuditView(props) {
      var [rows, setRows] = React.useState(null)
      React.useEffect(function () {
        props.call('traces', { limit: 30 })
          .then(function (v) { setRows(v || []) })
          .catch(function (e) { props.onError(e.message) })
      }, [])
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-k' }, '记录仪索引（正文 JSONL 才是真源；此页用于快速回放）。'),
        rows === null ? h('div', { className: 'mc-empty' }, '加载中…') :
        rows.length === 0 ? h('div', { className: 'mc-empty' }, '（暂无记录）') :
        h('div', { className: 'mc-list' }, rows.map(function (t, i) {
          return h('div', { key: t.trace_id || i, className: 'mc-item', style: { cursor: 'default' } },
            h('div', { className: 'mc-row' },
              h('span', { className: 'mc-tag' }, t.op),
              h('span', { className: 'mc-meta' }, String(t.at || '').replace('T', ' ').slice(0, 19)),
              h('span', { className: 'mc-meta' }, t.query_preview || '')),
            h('div', { className: 'mc-meta' }, (t.trace_id || '') + (t.hits && t.hits.length ? ' · ' + t.hits.length + ' 命中' : '')))
        })))
    }

    var SECTION_LABELS = {
      last: '1) 上次交接',
      projects: '2) 当前项目',
      changes: '3) 私有记忆变更',
      next: '4) 下一步',
      blockers: '5) 卡点',
    }

    function HandoffView(props) {
      var [rows, setRows] = React.useState(null)
      var [detail, setDetail] = React.useState(null)
      var [check, setCheck] = React.useState(null)
      function load() {
        props.call('handoffs')
          .then(function (v) { setRows(v || []) })
          .catch(function (e) { props.onError(e.message) })
      }
      React.useEffect(function () { load() }, [])
      function open(scene) {
        props.call('handoff', { scene: scene })
          .then(function (v) { setDetail(v); setCheck(null) })
          .catch(function (e) { props.onError(e.message) })
      }
      function runCheck(scene) {
        props.call('check', scene ? { scene: scene } : {})
          .then(function (v) { setCheck(v) })
          .catch(function (e) { props.onError(e.message) })
      }
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-row', style: { justifyContent: 'space-between' } },
          h('div', { className: 'mc-k' }, '每个场景一份「§〇 交接」：覆盖写、≤4 KB、五小节。换会话前必须先写。'),
          h('button', { className: 'mc-btn', onClick: function () { runCheck(detail ? detail.scene : null) } }, '体检')),
        check && check.items ? h('div', { className: 'mc-card' },
          check.items.map(function (i) {
            return h('div', { key: i.name, className: 'mc-meta ' + (i.ok ? 'mc-ok' : 'mc-err') },
              (i.ok ? '✓ ' : '✗ ') + i.name + ': ' + i.value + '/' + i.limit)
          })) : null,
        rows === null ? h('div', { className: 'mc-empty' }, '加载中…') :
        rows.length === 0 ? h('div', { className: 'mc-empty' }, '还没有交接。用 mem_handoff 写第一份。') :
        h('div', { className: 'mc-list' }, rows.map(function (r) {
          return h('div', { key: r.scene, className: 'mc-item', onClick: function () { open(r.scene) } },
            h('div', null, r.title || r.scene),
            h('div', { className: 'mc-meta' }, r.scene + ' · ' + r.bytes + '/4096 字节 · ' + String(r.updated_at || '').replace('T', ' ').slice(0, 19)))
        })),
        detail ? h('div', null,
          h('div', { className: 'mc-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'mc-k' }, detail.scene + ' · 更新于 ' + String(detail.updated_at || '').slice(0, 19)),
            h('button', { className: 'mc-btn', onClick: function () { setDetail(null) } }, '关闭')),
          Object.keys(SECTION_LABELS).filter(function (k) { return detail.sections && detail.sections[k] }).map(function (k) {
            return h('div', { key: k, className: 'mc-card' },
              h('div', { className: 'mc-k' }, SECTION_LABELS[k]),
              h('div', { style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, detail.sections[k]))
          })) : null)
    }

    function TaskView(props) {
      var [rows, setRows] = React.useState(null)
      var [detail, setDetail] = React.useState(null)
      function load() {
        props.call('tasks', { scope: 'all' })
          .then(function (v) { setRows(v || []) })
          .catch(function (e) { props.onError(e.message) })
      }
      React.useEffect(function () { load() }, [])
      function open(id) {
        props.call('task', { task_id: id })
          .then(function (v) { setDetail(v) })
          .catch(function (e) { props.onError(e.message) })
      }
      var tone = function (t) {
        if (t.overdue || t.effective_status === 'overdue') return 'mc-err'
        if (t.status === 'done' || t.status === 'closed') return 'mc-ok'
        return 'mc-warn'
      }
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-k' }, '派单台账：sent → delivered → acked → done。超时未回执会标红。'),
        rows === null ? h('div', { className: 'mc-empty' }, '加载中…') :
        rows.length === 0 ? h('div', { className: 'mc-empty' }, '台账是空的。') :
        h('div', { className: 'mc-list' }, rows.map(function (t) {
          return h('div', { key: t.task_id, className: 'mc-item', onClick: function () { open(t.task_id) } },
            h('div', null, (t.kind === 'dispatch' ? '派单 ' : '公告 ') + t.title),
            h('div', { className: 'mc-meta' },
              t.from_scene + ' → ' + t.to_scene + ' · ',
              h('span', { className: tone(t) }, t.overdue ? '超时未回执' : t.effective_status),
              ' · ' + String(t.created_at || '').slice(0, 10)))
        })),
        detail ? h('div', { className: 'mc-card' },
          h('div', { className: 'mc-row', style: { justifyContent: 'space-between' } },
            h('div', { className: 'mc-k' }, detail.task_id + ' · ' + detail.status),
            h('button', { className: 'mc-btn', onClick: function () { setDetail(null) } }, '关闭')),
          h('div', { style: { marginTop: '6px' } }, detail.title),
          detail.phenomenon ? h('div', { className: 'mc-meta', style: { marginTop: '6px' } }, '现象：' + detail.phenomenon) : null,
          detail.how_to ? h('div', { className: 'mc-meta' }, '照哪做：' + detail.how_to) : null,
          detail.how_verify ? h('div', { className: 'mc-meta' }, '怎么验：' + detail.how_verify) : null,
          detail.ack ? h('div', { style: { marginTop: '8px' } },
            h('div', { className: 'mc-k' }, '回执'),
            h('div', { className: 'mc-meta' }, '结论：' + detail.ack.conclusion),
            h('div', { className: 'mc-meta' }, '证据：' + detail.ack.evidence)) : null) : null)
    }

    function ObserveView(props) {
      var [data, setData] = React.useState(null)
      var [affect, setAffect] = React.useState(null)
      var [affectMsg, setAffectMsg] = React.useState('')
      function loadAffect() {
        props.call('affect/report', { range: 'day' })
          .then(function (v) { setAffect(v) })
          .catch(function () {})
      }
      React.useEffect(function () {
        props.call('observe')
          .then(function (v) { setData(v) })
          .catch(function (e) { props.onError(e.message) })
        loadAffect()
      }, [])
      if (!data) return h('div', { className: 'mc-empty' }, '加载中…')
      var s = data.stats || {}
      var a = data.affect || {}
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-k' }, '近 24 小时记忆活动。上下文构成请打开 dsh-context 的「Context」标签对照。'),
        h('div', { className: 'mc-grid' },
          h(Kpi, { label: '注入次数', value: data.injectCount }),
          h(Kpi, { label: '平均指针', value: data.avgPointers }),
          h(Kpi, { label: '检索次数', value: data.searchCount }),
          h(Kpi, { label: '有结果', value: data.hitCount }),
          h(Kpi, { label: '待审', value: s.pending, tone: s.pending > 20 ? 'mc-warn' : '' }),
          h(Kpi, { label: '审计', value: s.audit && s.audit.ok ? '一致' : '异常', tone: s.audit && s.audit.ok ? 'mc-ok' : 'mc-err' })),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k' }, '情绪分布（全部活跃记忆）'),
          h('div', { className: 'mc-meta', style: { marginTop: '6px' } },
            '中性 ' + (a.neutral || 0) + ' · 正面 ' + (a.positive || 0) + ' · 负面 ' + (a.negative || 0) + ' · 紧急 ' + (a.urgent || 0)),
          h('div', { className: 'mc-meta' }, '情绪标签在写入时由规则算出（效价/唤醒度），不调模型；重要性=基线+情绪强度+层级。')),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k' }, '近 14 天情绪趋势'),
          h('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            (data.trend || []).map(function (d) {
              var total = d.n || 0
              var badPct = total ? Math.round((d.bad / total) * 100) : 0
              var goodPct = total ? Math.round((d.good / total) * 100) : 0
              return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' } },
                h('span', { style: { width: '44px', color: '#888' } }, d.day.slice(5)),
                h('div', { style: { flex: 1, height: '8px', background: '#eee', borderRadius: '4px', display: 'flex', overflow: 'hidden' } },
                  h('div', { style: { width: badPct + '%', background: '#e5484d' } }),
                  h('div', { style: { width: goodPct + '%', background: '#30a46c' } })),
                h('span', { style: { width: '92px', textAlign: 'right', color: '#666' } }, total ? (total + ' 条 · 负 ' + d.bad + ' · 正 ' + d.good) : '—'))
            }))),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k' }, '今日情绪事件（QQ 采集）'),
          h('div', { className: 'mc-meta', style: { marginTop: '4px' } },
            affect
              ? ('事件 ' + affect.total + ' 条 · 负面占比 ' + Math.round(affect.negativeRatio * 100) + '% · 中性 ' + (affect.byLabel.neutral || 0) + ' · 正面 ' + (affect.byLabel.positive || 0) + ' · 负面 ' + (affect.byLabel.negative || 0) + ' · 紧急 ' + (affect.byLabel.urgent || 0))
              : '加载中…'),
          affect && affect.topTriggers && affect.topTriggers.length
            ? h('div', { className: 'mc-meta' }, '高频触发：' + affect.topTriggers.map(function (x) { return x.word + '×' + x.n }).join('、'))
            : null,
          h('div', { style: { marginTop: '6px' } },
            h('button', {
              className: 'mc-tab',
              onClick: function () {
                props.call('affect/ingest', { limit: 20 })
                  .then(function (v) { setAffectMsg('采集完成：新增 ' + v.added + ' 条（扫描 ' + v.scanned + '）'); loadAffect() })
                  .catch(function (e) { setAffectMsg('采集失败：' + e.message) })
              },
            }, '立即采集'),
            affectMsg ? h('span', { className: 'mc-meta', style: { marginLeft: '8px' } }, affectMsg) : null)),
        h('div', { className: 'mc-card' },
          h('div', { className: 'mc-k' }, '怎么读这组数'),
          h('div', { className: 'mc-meta', style: { marginTop: '6px' } }, '注入次数 = 系统提示词里带出记忆快照的次数；平均指针 = 每次带出几条。'),
          h('div', { className: 'mc-meta' }, '检索次数 / 有结果 = 模型主动 mem_search 的次数与命中率。'),
          h('div', { className: 'mc-meta' }, '要和上下文占用一起看：dsh-context 的 Context 标签给出 token 构成，这里给出记忆侧的活跃度。')))
    }

    function PartsView(props) {
      var [installed, setInstalled] = React.useState(null)
      var [plugins, setPlugins] = React.useState(null)
      var [meta, setMeta] = React.useState(null)
      var [query, setQuery] = React.useState('')
      var [category, setCategory] = React.useState('')
      var [lib, setLib] = React.useState(null)
      var [msg, setMsg] = React.useState('')
      var [busy, setBusy] = React.useState(false)
      var [job, setJob] = React.useState(null)
      var [copied, setCopied] = React.useState('')

      function refresh() {
        props.call('parts').then(setInstalled).catch(function () {})
        props.call('parts/installed').then(setPlugins).catch(function () {})
        props.call('parts/meta').then(setMeta).catch(function () {})
      }
      React.useEffect(refresh, [])
      React.useEffect(function () {
        props.call('parts/library', { query: query, category: category, limit: 40 })
          .then(setLib)
          .catch(function (e) { props.onError(e.message) })
      }, [query, category])

      function pollJob(jobId, key) {
        var timer = window.setInterval(function () {
          props.call('parts/job', { jobId: jobId }).then(function (v) {
            if (!v) return
            setJob({ id: jobId, key: key, percent: v.percent, message: v.message, state: v.state, error: v.error })
            if (v.state === 'done' || v.state === 'error') {
              window.clearInterval(timer)
              setBusy(false)
              if (v.state === 'done') {
                var name = v.result && v.result.package ? v.result.package : key
                setMsg('完成：' + name + '。请重启 DSH 生效。')
                refresh()
              } else {
                setMsg('失败：' + (v.error || '未知错误'))
              }
            }
          }).catch(function () { window.clearInterval(timer); setBusy(false) })
        }, 700)
      }
      function install(p) {
        if (!p.repo && !p.install) {
          setMsg((p.name || '') + '：没有安装链接，请按仓库说明手动安装')
          return
        }
        if (!window.confirm('安装 ' + p.name + ' ？\n\n' + (p.install || p.repo || '') + '\n\n安装后需要重启 DSH。')) return
        var key = p.id || p.name
        setBusy(true); setMsg('')
        setJob({ id: null, key: key, percent: 2, message: '启动安装…', state: 'running' })
        props.call('parts/install', { item: p })
          .then(function (v) { pollJob(v.jobId, key) })
          .catch(function (e) { setBusy(false); setJob(null); setMsg('安装失败：' + e.message) })
      }
      function uninstall(name) {
        if (!window.confirm('卸载 ' + name + ' ？卸载后需要重启。')) return
        setBusy(true); setMsg('')
        setJob({ id: null, key: name, percent: 2, message: '启动卸载…', state: 'running' })
        props.call('parts/uninstall', { name: name })
          .then(function (v) { pollJob(v.jobId, name) })
          .catch(function (e) { setBusy(false); setJob(null); setMsg('卸载失败：' + e.message) })
      }
      function copyLink(p) {
        var link = p.repo || p.install || ''
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link)
          setCopied(p.id || p.name)
          window.setTimeout(function () { setCopied('') }, 1500)
        } catch (error) {
          setMsg('复制失败：' + (error && error.message ? error.message : error))
        }
      }
      function progressBar(key) {
        if (!job || job.key !== key) return null
        var pct = Math.max(0, Math.min(100, job.percent || 0))
        var color = job.state === 'error' ? '#e5484d' : job.state === 'cancelled' ? '#888' : '#30a46c'
        return h('div', { style: { marginTop: '6px' } },
          h('div', { style: { height: '6px', background: 'rgba(127,127,127,.18)', borderRadius: '3px', overflow: 'hidden' } },
            h('div', { style: { width: pct + '%', height: '100%', background: color, transition: 'width .3s' } })),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '3px' } },
            h('span', { className: 'mc-meta' }, pct + '% · ' + (job.message || '')),
            job.state === 'running' && job.id
              ? h('button', { className: 'mc-tab', onClick: function () { props.call('parts/job/cancel', { jobId: job.id }).catch(function () {}) } }, '取消')
              : null))
      }

      var cats = meta && meta.categories ? Object.keys(meta.categories) : []
      return h('div', { className: 'mc-root' },
        msg ? h('div', { className: 'mc-banner' }, msg) : null,
        h('div', { className: 'mc-k' }, '内置零件（随工作台加载）'),
        h('div', { className: 'mc-card' }, (installed || []).map(function (p) {
          return h('div', { key: p.name, className: 'mc-meta', style: { marginTop: '4px' } }, '• ' + p.name + ' v' + p.version + '：' + p.describe)
        })),
        h('div', { className: 'mc-k', style: { marginTop: '10px' } }, '已装插件'),
        h('div', { className: 'mc-card' }, (plugins || []).length === 0 ? h('div', { className: 'mc-empty' }, '暂无') : (plugins || []).map(function (p) {
          return h('div', { key: p.name, style: { marginTop: '6px' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' } },
              h('span', { className: 'mc-meta' }, p.name + (p.version ? ' v' + p.version : '') + (p.bundle ? ' · 已登记' : '')),
              p.removable ? h('button', { className: 'mc-tab', disabled: busy, onClick: function () { uninstall(p.name) } }, '卸载') : null),
            progressBar(p.name))
        })),
        h('div', { className: 'mc-k', style: { marginTop: '10px' } }, '零件库' + (meta ? '（' + meta.count + '/' + meta.total + ' 条）' : '')),
        h('div', { className: 'mc-meta' }, '装不上？去「设置 → 插件 → 市场」搜同名零件；或点「复制安装链接」在终端安装。'),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '6px 0' } },
          h('input', {
            value: query,
            placeholder: '搜索零件（名称 / 作者 / 说明）',
            onChange: function (e) { setQuery(e.target.value) },
            style: { flex: '1 1 220px', padding: '6px 10px', borderRadius: '8px', border: '1px solid #ccc', fontSize: '13px' },
          }),
          h('button', { className: 'mc-tab', onClick: function () { setCategory('') } }, '全部'),
          cats.map(function (c) {
            return h('button', { key: c, className: 'mc-tab' + (category === c ? ' mc-tab-on' : ''), onClick: function () { setCategory(category === c ? '' : c) } }, c + ' ' + meta.categories[c])
          })),
        lib && lib.items ? (lib.items.length === 0 ? h('div', { className: 'mc-empty' }, '没有匹配的零件。') : lib.items.map(function (p) {
          return h('div', { key: p.id ?? p.name, className: 'mc-card', style: { marginTop: '6px' } },
            h('div', { className: 'mc-k' }, p.name + '  ★' + p.stars + '  · ' + p.category + (p.audited ? '  · 已审' : '')),
            h('div', { className: 'mc-meta', style: { marginTop: '4px' } }, p.summary || '（无说明）'),
            h('div', { className: 'mc-meta' }, '作者：' + (p.author || '未知') + ' ｜ ' + (p.repo || '')),
            h('div', { style: { marginTop: '6px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { className: 'mc-tab', disabled: busy, onClick: function () { install(p) } }, '安装'),
              h('button', { className: 'mc-tab', onClick: function () { setMsg((p.name || '') + '：' + (p.install || '按仓库说明安装')) } }, '查看说明'),
              h('button', { className: 'mc-tab', onClick: function () { copyLink(p) } }, copied === (p.id || p.name) ? '已复制' : '复制安装链接'),
              progressBar(p.id || p.name)))
        })) : h('div', { className: 'mc-empty' }, '加载中…'))
    }

    function SecurityView(props) {
      var [targets, setTargets] = React.useState([])
      var [report, setReport] = React.useState(null)
      var [busy, setBusy] = React.useState(false)
      var [error, setError] = React.useState('')

      function tsCall(endpoint, payload) {
        return fetch('/threat-scan/' + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        }).then(function (r) {
          if (r.status === 404) throw new Error('安全扫描插件未安装')
          return r.json()
        }).then(function (j) {
          if (!j || j.ok !== true) throw new Error((j && j.error && j.error.message) || '请求失败')
          return j.value
        })
      }
      React.useEffect(function () {
        tsCall('discover', {}).then(function (v) { setTargets((v && v.units) || []) }).catch(function (e) { setError(e.message) })
      }, [])
      function run(marketplace) {
        setBusy(true); setError('')
        var paths = (targets || []).map(function (t) { return t.path })
        tsCall('scan', { paths: paths, deep: true, online: false, lookup: false, marketplace: marketplace === true })
          .then(function (v) { setReport(v) })
          .catch(function (e) { setError(e.message) })
          .then(function () { setBusy(false) })
      }
      var su = report && report.summary ? report.summary : null
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-k' }, '插件安全扫描（dsh-plugin-threat-scan）：本地启发式静态分析，不联网、不执行被扫代码。'),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '8px 0' } },
          h('button', { className: 'mc-tab', disabled: busy, onClick: function () { run(false) } }, '扫描已发现目标（' + (targets || []).length + '）'),
          h('button', { className: 'mc-tab', disabled: busy, onClick: function () { run(true) } }, '扫描整个插件市场')),
        error ? h('div', { className: 'mc-banner' }, error) : null,
        su ? h('div', { className: 'mc-card' },
          h('div', { className: 'mc-meta' }, '严重 ' + su.critical + ' · 高 ' + su.high + ' · 中 ' + su.medium + ' · 低 ' + su.low),
          h('div', { className: 'mc-meta' }, '风险插件 ' + su.riskyUnits + ' · 含真实命中 ' + su.unitsWithRealHits + ' · URL ' + su.urlCount + ' · 情报命中 ' + su.feedHits)) : null,
        report && Array.isArray(report.records) ? report.records.slice(0, 20).map(function (r, i) {
          return h('div', { key: 'r' + i, className: 'mc-meta' }, '· [' + r.severity + '] ' + (r.rel || r.path) + ' — ' + (r.label || r.magic || ''))
        }) : null)
    }

    function Panel(props) {
      var rpc = props.connection && props.connection.rpc
      var safeRpc = rpc || { call: function () { return Promise.reject(new Error('连接服务不可用')) } }
      var call = useRpc(safeRpc)
      var [tab, setTab] = React.useState('mem')
      var [sub, setSub] = React.useState('overview')
      var [status, setStatus] = React.useState(null)
      var [error, setError] = React.useState('')

      function loadStatus() {
        call('status')
          .then(function (v) { setStatus(v); setError('') })
          .catch(function (e) { setError(e.message) })
      }
      React.useEffect(function () { loadStatus() }, [])

      if (!rpc) return h('div', { className: 'mc-empty' }, '连接服务不可用：这个位置需要 connection 服务。')

      var tabs = [
        ['mem', '记忆可视化'],
        ['more', '更多'],
      ]
      var moreTabs = [
        ['overview', '总览'],
        ['search', '检索'],
        ['review', '待审'],
        ['handoff', '交接'],
        ['tasks', '派单'],
        ['observe', '观测'],
        ['timeline', '时间轴'],
        ['parts', '零件'],
        ['security', '安全'],
        ['audit', '审计'],
      ]

      return h('div', { className: 'mc-root' },
        error ? h('div', { className: 'mc-banner' }, error) : null,
        status && status.audit && status.audit.ok === false
          ? h('div', { className: 'mc-banner' }, '审计链异常：' + (status.audit.brokenAt || '未知位置'))
          : null,
        h('div', { className: 'mc-tabs' }, tabs.map(function (t) {
          return h('button', {
            key: t[0],
            className: 'mc-tab' + (tab === t[0] ? ' mc-tab-on' : ''),
            onClick: function () { setTab(t[0]); if (t[0] === 'more' && sub === 'overview') loadStatus() },
          }, t[1])
        }), h('span', { key: 'v', className: 'mc-meta', style: { marginLeft: 'auto', alignSelf: 'center' } }, 'v1.9.3')),
        tab === 'more' ? h('div', { className: 'mc-tabs' }, moreTabs.map(function (t) {
          return h('button', {
            key: t[0],
            className: 'mc-tab' + (sub === t[0] ? ' mc-tab-on' : ''),
            onClick: function () { setSub(t[0]); if (t[0] === 'overview') loadStatus() },
          }, t[1])
        })) : null,
        tab === 'mem' ? h(MemoryVis, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'overview' ? h(Overview, { status: status, onJump: function (id) { setTab('more'); setSub(id) } }) : null,
        tab === 'more' && sub === 'search' ? h(SearchView, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'review' ? h(ReviewView, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'handoff' ? h(HandoffView, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'tasks' ? h(TaskView, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'observe' ? h(ObserveView, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'timeline' ? h(TimelineView, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'parts' ? h(PartsView, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'security' ? h(SecurityView, { call: call, onError: setError }) : null,
        tab === 'more' && sub === 'audit' ? h(AuditView, { call: call, onError: setError }) : null)
    }

    function GraphCanvas(props) {
      var wrapRef = React.useRef(null)
      var cvRef = React.useRef(null)
      var st = React.useRef({ nodes: [], edges: [], zoom: 1, panX: 0, panY: 0, drag: null, hover: null, down: null })
      var [tip, setTip] = React.useState(null)
      var [legend, setLegend] = React.useState([])

      var COL = { L1: '#38bdf8', L2: '#a78bfa', L3: '#34d399', L4: '#fbbf24', L5: '#f472b6', L6: '#94a3b8' }

      function resize() {
        var cv = cvRef.current
        if (!cv || !wrapRef.current) return
        var r = wrapRef.current.getBoundingClientRect()
        cv.width = Math.max(320, Math.floor(r.width))
        cv.height = Math.max(320, Math.floor(r.height))
      }

      function layout() {
        var cv = cvRef.current
        if (!cv) return
        var W = cv.width, H = cv.height
        var s = st.current
        var n = s.nodes.length
        if (!n) return
        // 初始位置：按层级分圈，避免全挤在一起
        for (var i = 0; i < n; i++) {
          var node = s.nodes[i]
          var ring = node.layer === 'L1' ? 0.55 : node.layer === 'L2' ? 0.78 : 1.0
          var a = i * 2.399
          node.x = W / 2 + Math.cos(a) * W * 0.32 * ring
          node.y = H / 2 + Math.sin(a) * H * 0.32 * ring
          node.vx = 0
          node.vy = 0
        }
        // 力导向：斥力 + 弹簧 + 向心
        for (var it = 0; it < 420; it++) {
          for (var i2 = 0; i2 < n; i2++) {
            var a2 = s.nodes[i2]
            for (var j = i2 + 1; j < n; j++) {
              var b2 = s.nodes[j]
              var dx = a2.x - b2.x, dy = a2.y - b2.y
              var d2 = dx * dx + dy * dy || 0.01
              if (d2 < 60000) {
                var f = 1200 / d2
                a2.vx += dx * f; a2.vy += dy * f
                b2.vx -= dx * f; b2.vy -= dy * f
              }
            }
            a2.vx += (W / 2 - a2.x) * 0.006
            a2.vy += (H / 2 - a2.y) * 0.006
          }
          for (var k = 0; k < s.edges.length; k++) {
            var e = s.edges[k], na = s.nodes[e.a], nb = s.nodes[e.b]
            var ddx = nb.x - na.x, ddy = nb.y - na.y
            var d = Math.sqrt(ddx * ddx + ddy * ddy) || 1
            var ff = (d - 70) * 0.02
            na.vx += ddx / d * ff; na.vy += ddy / d * ff
            nb.vx -= ddx / d * ff; nb.vy -= ddy / d * ff
          }
          for (var n2 = 0; n2 < n; n2++) {
            var nn = s.nodes[n2]
            nn.vx *= 0.82; nn.vy *= 0.82
            nn.x += nn.vx * 0.35
            nn.y += nn.vy * 0.35
            if (!isFinite(nn.x) || !isFinite(nn.y)) { nn.x = W / 2; nn.y = H / 2 }
          }
        }
        fit()
      }

      // 视图自适应：让所有节点落在画面里
      function fit() {
        var cv = cvRef.current
        if (!cv) return
        var s = st.current
        if (!s.nodes.length) return
        var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9
        for (var i = 0; i < s.nodes.length; i++) {
          var n = s.nodes[i]
          if (n.x < minX) minX = n.x
          if (n.x > maxX) maxX = n.x
          if (n.y < minY) minY = n.y
          if (n.y > maxY) maxY = n.y
        }
        var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY)
        var pad = 60
        var z = Math.min((cv.width - pad * 2) / w, (cv.height - pad * 2) / h, 2.2)
        z = Math.max(0.3, z)
        s.zoom = z
        s.panX = cv.width / 2 - (minX + maxX) / 2 * z
        s.panY = cv.height / 2 - (minY + maxY) / 2 * z
        draw()
      }

      function draw() {
        var cv = cvRef.current
        if (!cv) return
        var ctx = cv.getContext('2d')
        var s = st.current
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, cv.width, cv.height)
        // 背景点阵，让画面不那么空
        ctx.fillStyle = 'rgba(103,232,249,.045)'
        for (var gx = 20; gx < cv.width; gx += 36) {
          for (var gy = 20; gy < cv.height; gy += 36) {
            ctx.fillRect(gx, gy, 1.2, 1.2)
          }
        }
        ctx.translate(s.panX, s.panY)
        ctx.scale(s.zoom, s.zoom)
        // 边
        ctx.strokeStyle = 'rgba(103,232,249,.10)'
        ctx.lineWidth = 0.7 / s.zoom
        for (var i = 0; i < s.edges.length; i++) {
          var e = s.edges[i], a = s.nodes[e.a], b = s.nodes[e.b]
          var hot = s.hover && (a === s.hover || b === s.hover)
          if (hot) { ctx.strokeStyle = 'rgba(103,232,249,.55)'; ctx.lineWidth = 1.4 / s.zoom }
          else { ctx.strokeStyle = 'rgba(103,232,249,.10)'; ctx.lineWidth = 0.7 / s.zoom }
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
        }
        // 节点
        for (var k = 0; k < s.nodes.length; k++) {
          var n = s.nodes[k]
          var isHover = n === s.hover
          var r = (n.layer === 'L2' ? 6.5 : 5) / Math.max(0.6, s.zoom * 0.75)
          ctx.beginPath()
          ctx.fillStyle = isHover ? '#ffffff' : (COL[n.layer] || '#94a3b8')
          if (isHover) { ctx.shadowColor = '#67e8f9'; ctx.shadowBlur = 18 } else { ctx.shadowBlur = 0 }
          ctx.arc(n.x, n.y, isHover ? r + 2 : r, 0, Math.PI * 2)
          ctx.fill()
          ctx.shadowBlur = 0
        }
      }

      function build() {
        resize()
        var cv = cvRef.current
        if (!cv) return
        var data = props.data || { nodes: [], edges: [] }
        var nodes = (data.nodes || []).map(function (n) {
          return { id: n.record_id, layer: n.layer, summary: n.summary, x: 0, y: 0, vx: 0, vy: 0, r: n.layer === 'L2' ? 6.5 : 5 }
        })
        var idx = new Map(nodes.map(function (n, i) { return [n.id, i] }))
        var edges = (data.edges || []).filter(function (e) { return idx.has(e.from_id) && idx.has(e.to_id) }).map(function (e) { return { a: idx.get(e.from_id), b: idx.get(e.to_id) } })
        st.current.nodes = nodes
        st.current.edges = edges
        var counts = {}
        nodes.forEach(function (n) { counts[n.layer] = (counts[n.layer] || 0) + 1 })
        setLegend(Object.keys(COL).filter(function (k) { return counts[k] }).map(function (k) { return { layer: k, n: counts[k], color: COL[k] } }))
        layout()
      }

      React.useEffect(function () { build() }, [props.data])
      React.useEffect(function () {
        function onResize() { resize(); fit() }
        window.addEventListener('resize', onResize)
        return function () { window.removeEventListener('resize', onResize) }
      }, [])

      function pos(ev) { var r = cvRef.current.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top } }
      function toWorld(p) { var s = st.current; return { x: (p.x - s.panX) / s.zoom, y: (p.y - s.panY) / s.zoom } }

      function onDown(ev) {
        var p = pos(ev), w = toWorld(p), s = st.current
        var hit = null
        for (var i = 0; i < s.nodes.length; i++) {
          if (Math.sqrt(Math.pow(s.nodes[i].x - w.x, 2) + Math.pow(s.nodes[i].y - w.y, 2)) < 14 / s.zoom + s.nodes[i].r) { hit = s.nodes[i]; break }
        }
        // 记下来：点在谁身上、从哪儿开始 —— 松开时用来区分「点一下」和「拖一下」
        s.down = { node: hit, x: p.x, y: p.y, moved: false }
        if (hit) s.drag = { node: hit, dx: w.x - hit.x, dy: w.y - hit.y }
        else s.drag = { pan: true, startX: p.x, startY: p.y, panX: s.panX, panY: s.panY }
      }

      function onMove(ev) {
        var s = st.current, p = pos(ev), w = toWorld(p)
        if (s.down && Math.abs(p.x - s.down.x) + Math.abs(p.y - s.down.y) > 4) s.down.moved = true
        if (s.drag) {
          if (s.drag.node) { s.drag.node.x = w.x - s.drag.dx; s.drag.node.y = w.y - s.drag.dy; draw() }
          else { s.panX = s.drag.panX + (p.x - s.drag.startX); s.panY = s.drag.panY + (p.y - s.drag.startY); draw() }
          return
        }
        var hover = null
        for (var i = 0; i < s.nodes.length; i++) {
          if (Math.sqrt(Math.pow(s.nodes[i].x - w.x, 2) + Math.pow(s.nodes[i].y - w.y, 2)) < s.nodes[i].r + 8 / s.zoom) { hover = s.nodes[i]; break }
        }
        if (hover !== s.hover) {
          s.hover = hover
          draw()
          if (cvRef.current) cvRef.current.style.cursor = hover ? 'pointer' : 'grab'
          var hv = hover ? dispOf(hover) : null
          setTip(hv ? { x: Math.min(p.x + 14, cvRef.current.width - 350), y: p.y + 10, title: hv.title, plain: hv.plain, meta: hv.meta } : null)
        }
      }

      // 松开：没拖动过就是「点一下」→ 打开这条记忆的全部细节；点空白处 → 收起详情
      function onUp() {
        var s = st.current
        var down = s.down
        s.drag = null
        s.down = null
        if (!down || down.moved) return
        if (typeof props.onOpen === 'function') props.onOpen(down.node ? down.node.id : null)
      }

      // 指针离开画布：只清状态，不当成点击
      function onCancel() {
        st.current.drag = null
        st.current.down = null
      }

      function onWheel(ev) {
        ev.preventDefault()
        var p = pos(ev), s = st.current
        var before = toWorld(p)
        s.zoom = Math.max(0.2, Math.min(4, s.zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)))
        var after = toWorld(p)
        s.panX += (after.x - before.x) * s.zoom
        s.panY += (after.y - before.y) * s.zoom
        draw()
      }

      return h('div', { ref: wrapRef, style: { position: 'relative', height: '520px', border: '1px solid var(--dsh-border, rgba(127,127,127,.22))', borderRadius: '10px', overflow: 'hidden', background: 'radial-gradient(900px 500px at 50% 0%, rgba(11,32,56,.9), rgba(3,6,13,.95))' } },
        h('canvas', {
          ref: cvRef,
          style: { display: 'block', width: '100%', height: '100%', cursor: 'grab' },
          onMouseDown: onDown, onMouseMove: onMove, onMouseUp: onUp, onMouseLeave: onCancel, onWheel: onWheel,
        }),
        h('div', { style: { position: 'absolute', right: '10px', top: '10px', display: 'flex', gap: '6px' } },
          h('button', { className: 'mc-tab', onClick: fit }, '适应'),
          h('button', { className: 'mc-tab', onClick: function () { layout(); fit() } }, '重排')),
        h('div', { style: { position: 'absolute', left: '10px', bottom: '10px', fontSize: '11px', color: '#cfe6ff', display: 'flex', gap: '10px', background: 'rgba(3,10,20,.75)', padding: '4px 8px', borderRadius: '8px' } },
          legend.map(function (x) {
            return h('span', { key: x.layer }, h('i', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: x.color, marginRight: '4px' } }), x.layer + ' ' + x.n)
          })),
        h('div', { style: { position: 'absolute', right: '10px', bottom: '10px', fontSize: '11px', color: '#9fb6d8' } }, '点一下看详情 / 拖节点 / 滚轮缩放'),
        tip ? h('div', { style: { position: 'absolute', left: tip.x, top: tip.y, background: '#0a1626', color: '#e6f2ff', border: '1px solid rgba(103,232,249,.45)', borderRadius: '8px', padding: '7px 10px', fontSize: '12px', lineHeight: '1.55', maxWidth: '340px', pointerEvents: 'none', boxShadow: '0 6px 20px rgba(0,0,0,.55)', zIndex: 20 } },
          h('div', { style: { fontWeight: 600, fontSize: '13px' } }, tip.title),
          tip.plain ? h('div', { style: { marginTop: '3px', color: '#b7cde6' } }, tip.plain) : null,
          tip.meta ? h('div', { style: { marginTop: '4px', color: '#7f9cbd', fontSize: '11px' } }, tip.meta) : null) : null)
    }

    function MemoryVis(props) {
      var [view, setView] = React.useState('graph')
      var [stats, setStats] = React.useState(null)
      var [rows, setRows] = React.useState(null)
      var [q, setQ] = React.useState('')
      var [layer, setLayer] = React.useState('')
      var [detail, setDetail] = React.useState(null)
      var [graphData, setGraphData] = React.useState(null)
      var [tl, setTl] = React.useState(null)
      var detailRef = React.useRef(null)

      // 点圆球打开详情后，把它滚进视野（画布占了 520px，详情在下面）
      React.useEffect(function () {
        if (!detail) return
        var el = detailRef.current
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, [detail])

      function loadStats() { props.call('status').then(function (v) { setStats(v) }).catch(function (e) { props.onError(e.message) }) }
      function loadRows() { props.call('records', { layer: layer || undefined, limit: 300 }).then(function (v) { setRows(v || []) }).catch(function (e) { props.onError(e.message) }) }
      function runSearch() {
        if (!q.trim()) { loadRows(); return }
        props.call('search', { query: q, topK: 30 }).then(function (v) {
          setRows((v || []).map(function (r) { return { record_id: r.record_id, layer: r.layer, summary: r.snippet, created_at: r.created_at } }))
        }).catch(function (e) { props.onError(e.message) })
      }
      function open(id) { props.call('read', { record_id: id }).then(function (v) { setDetail(v) }).catch(function (e) { props.onError(e.message) }) }

      React.useEffect(function () { loadStats(); loadRows() }, [layer])
      React.useEffect(function () {
        if (view === 'graph' && !graphData) props.call('graph.all').then(function (v) { setGraphData(v) }).catch(function (e) { props.onError(e.message) })
        if (view === 'timeline' && !tl) props.call('timeline', { days: 14 }).then(function (v) { setTl(v) }).catch(function (e) { props.onError(e.message) })
      }, [view])

      var layers = stats ? (stats.layers || []) : []
      return h('div', { className: 'mc-root' },
        h('div', { className: 'mc-row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('input', { className: 'mc-input', value: q, placeholder: '搜记忆…', style: { flex: '1 1 220px' }, onChange: function (e) { setQ(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') runSearch() } }),
          h('button', { className: 'mc-btn', onClick: runSearch }, '搜索'),
          h('button', { className: 'mc-btn', onClick: function () { setQ(''); loadRows() } }, '全部'),
          h('button', { className: 'mc-tab' + (view === 'graph' ? ' mc-tab-on' : ''), onClick: function () { setView('graph') } }, '关系图'),
          h('button', { className: 'mc-tab' + (view === 'list' ? ' mc-tab-on' : ''), onClick: function () { setView('list') } }, '列表'),
          h('button', { className: 'mc-tab' + (view === 'timeline' ? ' mc-tab-on' : ''), onClick: function () { setView('timeline') } }, '时间轴')),
        stats ? h('div', { className: 'mc-meta', style: { marginTop: '6px' } },
          '记录 ' + stats.records + ' · ' + layers.map(function (x) { return x.layer + ':' + x.n }).join(' ') + ' · S 级 ' + stats.sLevel + ' · 关系图可拖拽/滚轮缩放') : null,
        view === 'graph' ? h(GraphCanvas, {
          data: graphData || { nodes: [], edges: [] },
          onOpen: function (id) { if (id) open(id); else setDetail(null) },
        }) : null,
        view === 'graph' && detail ? h('div', { ref: detailRef },
          h(DetailCard, { detail: detail, onClose: function () { setDetail(null) }, onOpen: open })) : null,
        view === 'timeline' ? h('div', null, tl ? tl.groups.map(function (g) {
          return h('div', { key: g.date, className: 'mc-card' },
            h('div', { className: 'mc-k' }, g.date + ' · 情绪 ' + g.affect.length + ' · 记忆 ' + g.memories.length),
            g.memories.map(function (m) {
              return h(MemRow, { key: m.record_id, row: m, onClick: function () { open(m.record_id) } })
            }))
        }) : h('div', { className: 'mc-empty' }, '加载中…')) : null,
        view === 'list' ? h('div', { style: { display: 'flex', gap: '10px', marginTop: '8px' } },
          h('div', { style: { flex: '1 1 46%', maxHeight: '480px', overflow: 'auto' } },
            rows === null ? h('div', { className: 'mc-empty' }, '加载中…') :
              rows.length === 0 ? h('div', { className: 'mc-empty' }, '没有记录') :
              rows.map(function (r) {
                return h(MemRow, { key: r.record_id, row: r, onClick: function () { open(r.record_id) } })
              })),
          h('div', { style: { flex: '1 1 54%' } },
            detail ? h(DetailCard, { detail: detail, onClose: function () { setDetail(null) }, onOpen: open }) : h('div', { className: 'mc-empty' }, '点左边一条看详情'))) : null)
    }

    var ErrorBoundary = (function () {
      if (typeof React.Component !== 'function') {
        return function (p) { return p && p.children ? p.children : null }
      }
      return class ErrorBoundary extends React.Component {
        constructor(props) { super(props); this.state = { err: null } }
        static getDerivedStateFromError(error) { return { err: error } }
        render() {
          if (this.state && this.state.err) {
            return h('div', { className: 'mc-banner' }, '面板渲染出错：' + (this.state.err.message || String(this.state.err)))
          }
          return this.props.children || null
        }
      }
    })()

    function apply(ctx) {
      var slots = ctx.slots
      if (!slots) {
        console.warn('[dsh-memory-core] slots 服务缺失，面板禁用')
        return
      }
      var tag = null
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-sixlayer-memory"]') === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-memory-core'
        tag.dataset.pluginCss = 'dsh-memory-core'
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'memory-core', order: 27, label: function () { return '工作台' } },
          function () { return h(ErrorBoundary, null, h(Panel, { connection: ctx.connection })) },
        )
      })

      try {
        slots.inject('conversation.view', function () {
          return slots.register(
            { name: 'conversation.view', id: 'memory-core-view', order: 36, label: function () { return '记忆' } },
            function () { return h(ErrorBoundary, null, h(Panel, { connection: ctx.connection })) },
          )
        })
      } catch (error) {
        console.warn('[dsh-sixlayer-memory] conversation.view 注册失败:', error)
      }

      // B5：右侧栏「记忆」页签，和 dsh-context 的 Context 并排（不 fork 它）
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs'], function (sub) {
            var tabs = sub.sidebarRightTabs
            if (!tabs || typeof tabs.register !== 'function') return
            var disposers = []
            try {
              disposers.push(tabs.register({
                id: 'memory-core',
                kind: 'memory-core',
                title: function () { return '记忆' },
                guide: [{
                  order: 30,
                  title: function () { return '记忆' },
                  description: function () { return '记忆底座：总览 / 检索 / 待审 / 交接 / 派单 / 观测 / 审计' },
                }],
              }))
            } catch (error) {
              console.warn('[dsh-memory-core] sidebarRightTabs.register failed:', error)
            }
            try {
              disposers.push(sub.slots.inject('sidebar.right.pane.tab', function () {
                return sub.slots.register(
                  { name: 'sidebar.right.pane.tab', key: 'memory-core' },
                  function (paneProps) {
                    return h(Panel, { connection: (sub && sub.connection) || ctx.connection || (paneProps && paneProps.connection) })
                  },
                )
              }))
            } catch (error) {
              console.warn('[dsh-memory-core] sidebar.right.pane.tab failed:', error)
            }
            try {
              disposers.push(sub.slots.inject('sidebar.right.pane.tab.title', function () {
                return sub.slots.register(
                  { name: 'sidebar.right.pane.tab.title', key: 'memory-core' },
                  function () { return h('span', null, '记忆') },
                )
              }))
            } catch (error) {
              console.warn('[dsh-memory-core] sidebar.right.pane.tab.title failed:', error)
            }
            return function () {
              disposers.forEach(function (dispose) {
                try { if (typeof dispose === 'function') dispose() } catch { /* 忽略 */ }
              })
            }
          })
        }
      } catch (error) {
        console.warn('[dsh-memory-core] 侧栏页签不可用:', error)
      }
      ctx.effect(function () {
        return function () { if (tag !== null && tag.isConnected) tag.remove() }
      })
    }

    module.exports = { name: name, inject: inject, apply: apply }
    return module.exports
  },
})
