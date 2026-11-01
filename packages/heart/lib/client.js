// dsh-heart 的客户端半边：设置页里的「心」面板。
// 不打包、不依赖构建：浏览器侧用 ModuleLoader 的工厂格式，React 从宿主 require。
window.__ModuleLoader__.load({
  id: '@dsh/heart',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const chip = {
      display: 'inline-block',
      padding: '2px 8px',
      marginRight: 6,
      borderRadius: 999,
      background: 'var(--dsh-surface-2, rgba(127,127,127,.12))',
      fontSize: 12,
    }
    const row = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 13 }
    const btn = {
      padding: '6px 12px',
      marginRight: 8,
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
      background: 'transparent',
      cursor: 'pointer',
      fontSize: 13,
    }
    const input = {
      padding: '4px 6px',
      borderRadius: 6,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
      background: 'transparent',
      color: 'inherit',
      width: 56,
      fontSize: 13,
    }
    const labelInput = { ...input, width: 92 }
    const idText = {
      width: 84,
      fontFamily: 'ui-monospace, monospace',
      fontSize: 12,
      opacity: 0.7,
    }

    function Panel() {
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [newCat, setNewCat] = React.useState({ id: '', label: '', dailyCap: 2 })
      const [note, setNote] = React.useState('')

      const load = React.useCallback(() => {
        fetch('/api/dsh-heart/state', { credentials: 'include' })
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.json()
          })
          .then(setData)
          .catch((e) => setNote('读不到状态：' + e.message))
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, 5000)
        return () => clearInterval(timer)
      }, [load])

      React.useEffect(() => {
        if (!data || draft) return
        setDraft({
          totalCap: (data.idle && data.idle.totalCap) || 6,
          categories: ((data.idle && data.idle.categories) || []).map((c) => ({
            id: c.id,
            label: c.label,
            dailyCap: c.dailyCap,
          })),
        })
      }, [data, draft])

      const act = (url, label) => {
        setNote(label + '…')
        fetch(url, { method: 'POST' })
          .then((r) => r.json())
          .then((v) => {
            setNote(label + '：' + JSON.stringify(v).slice(0, 160))
            load()
          })
          .catch((e) => setNote(label + '失败：' + e.message))
      }

      if (!data) {
        return h('div', { style: { padding: 12, fontSize: 13 } }, note || '加载中…')
      }

      const usedById = {}
      ;((data.idle && data.idle.categories) || []).forEach((c) => {
        usedById[c.id] = c.used
      })
      const d = draft || { totalCap: 6, categories: [] }

      const setCat = (i, patch) => {
        setDraft({
          ...d,
          categories: d.categories.map((c, j) => (j === i ? { ...c, ...patch } : c)),
        })
      }
      const removeCat = (i) => {
        setDraft({ ...d, categories: d.categories.filter((_, j) => j !== i) })
      }
      const addCat = () => {
        const id = String(newCat.id || '')
          .trim()
          .toLowerCase()
        if (!/^[a-z0-9_-]{1,24}$/.test(id)) {
          setNote('类别 id 只能用字母/数字/下划线/横线')
          return
        }
        if (d.categories.some((c) => c.id === id)) {
          setNote('已经有这个类别了')
          return
        }
        setDraft({
          ...d,
          categories: [
            ...d.categories,
            { id, label: String(newCat.label || id).trim() || id, dailyCap: Number(newCat.dailyCap) || 2 },
          ],
        })
        setNewCat({ id: '', label: '', dailyCap: 2 })
      }
      const save = () => {
        setNote('保存…')
        fetch('/api/dsh-heart/config', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idleTurnDailyCap: Number(d.totalCap) || 0,
            idleCategories: d.categories.map((c) => ({
              id: c.id,
              label: c.label,
              dailyCap: Number(c.dailyCap) || 0,
            })),
          }),
        })
          .then((r) => r.json())
          .then((v) => {
            if (!v.ok) throw new Error(v.error || '保存失败')
            setNote('已保存')
            setDraft(null)
            load()
          })
          .catch((e) => setNote('保存失败：' + e.message))
      }

      return h(
        'div',
        { style: { padding: '4px 2px 16px' } },
        h('div', { style: row }, h('span', { style: chip }, '身体：' + data.body)),
        h('div', { style: row }, h('span', { style: chip }, '本子 ' + data.notebookEntries)),
        h('div', { style: row }, h('span', { style: chip }, '事实 ' + data.factEntries)),
        h('div', { style: row }, h('span', { style: chip }, '情节 ' + data.memoryEntries)),
        h('div', { style: row }, h('span', { style: chip }, '器官 ' + (data.organs || []).join(' / '))),
        h(
          'div',
          { style: row },
          h('span', { style: chip }, data.config && data.config.pulse ? '节律开 · ' + data.config.pulseSeconds + 's' : '节律关'),
          data.speak ? h('span', { style: chip }, '档位 ' + data.speak.level + ' · 今日 ' + (data.speak.usedToday || 0) + ' · 待发 ' + data.speak.outbox) : null,
        ),
        h(
          'div',
          { style: { margin: '10px 0' } },
          h('button', { style: btn, onClick: () => act('/api/dsh-heart/tick', '叫它醒一次') }, '现在醒一次'),
          h('button', { style: btn, onClick: () => act('/api/dsh-heart/export', '导出') }, '导出备份'),
          h('button', { style: btn, onClick: load }, '刷新')
        ),
        note ? h('div', { style: { fontSize: 12, opacity: 0.7, margin: '4px 0 8px' } }, note) : null,

        h('div', { style: { fontSize: 12, opacity: 0.6, margin: '12px 0 4px' } }, '空闲活动额度（每天）'),
        h(
          'div',
          { style: row },
          h('span', { style: { fontSize: 13 } }, '总数'),
          h('input', {
            type: 'number',
            min: 0,
            max: 99,
            value: d.totalCap,
            style: input,
            onChange: (e) => setDraft({ ...d, totalCap: Number(e.target.value) }),
          }),
          h('span', { style: { fontSize: 12, opacity: 0.6 } }, '今日 ' + ((data.idle && data.idle.totalUsed) || 0))
        ),
        ...d.categories.map((c, i) =>
          h(
            'div',
            { style: row, key: c.id },
            h('span', { style: idText }, c.id),
            h('input', {
              value: c.label,
              style: labelInput,
              onChange: (e) => setCat(i, { label: e.target.value }),
            }),
            h('input', {
              type: 'number',
              min: 0,
              max: 99,
              value: c.dailyCap,
              style: input,
              onChange: (e) => setCat(i, { dailyCap: Number(e.target.value) }),
            }),
            h('span', { style: { fontSize: 12, opacity: 0.6 } }, '已用 ' + (usedById[c.id] || 0)),
            h('button', { style: { ...btn, padding: '2px 8px' }, onClick: () => removeCat(i) }, '删')
          )
        ),
        h(
          'div',
          { style: row },
          h('input', {
            placeholder: 'id',
            value: newCat.id,
            style: input,
            onChange: (e) => setNewCat({ ...newCat, id: e.target.value }),
          }),
          h('input', {
            placeholder: '名称',
            value: newCat.label,
            style: labelInput,
            onChange: (e) => setNewCat({ ...newCat, label: e.target.value }),
          }),
          h('input', {
            type: 'number',
            min: 0,
            max: 99,
            value: newCat.dailyCap,
            style: input,
            onChange: (e) => setNewCat({ ...newCat, dailyCap: Number(e.target.value) }),
          }),
          h('button', { style: btn, onClick: addCat }, '加类别')
        ),
        h(
          'div',
          { style: { margin: '6px 0 10px' } },
          h('button', { style: btn, onClick: save }, '保存额度')
        ),
        h('div', { style: { fontSize: 12, opacity: 0.55, margin: '4px 0 8px' } },
          '下一拍：' + ((data.idle && data.idle.nextIdleAt) || '未排') +
          '；各类别用完后不会再起空闲回合。'
        ),

        h('div', { style: { fontSize: 12, opacity: 0.6, margin: '10px 0 4px' } }, '时间线'),
        h(
          'div',
          {
            style: {
              fontFamily: 'ui-monospace, monospace',
              fontSize: 12,
              lineHeight: 1.7,
              maxHeight: 220,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            },
          },
          (data.pulse && data.pulse.length ? data.pulse.slice().reverse().join('\n') : '（还没有醒过）')
        )
      )
    }

    exports.inject = ['timer']
    exports.apply = (ctx) => {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'dsh-heart', order: 32, label: () => '心' },
          () => h(Panel)
        )
      )
    }

    return module.exports
  },
})
