/**
 * Client half of the sampling-temperature plugin.
 *
 * A compact control in the composer tool row shows the temperature this session
 * applies to its model requests. Clicking it opens a small popover with a
 * slider, preset values, and a reset back to the model default.
 *
 * The control talks to its own Host half over one exact same-origin route. No
 * Harness Client package is imported, so only React and the theme tokens are
 * shared with the surrounding application.
 */

window.__ModuleLoader__.load({
  id: '@local/temperature-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LOCALE_NS = 'temperature-control'
    const ENDPOINT = '/plugin/temperature-control/state'
    const MIN = 0
    const MAX = 2
    const STEP = 0.1
    const PRESETS = [0.2, 0.5, 0.7, 1]

    const zh = {
      'button.aria': '采样温度',
      'button.auto': '自动',
      'panel.title': '采样温度',
      'panel.hint': '应用于本会话中设置之后发送的每次模型请求。',
      'panel.default': '模型默认',
      'panel.loading': '读取中…',
      'panel.reset': '恢复默认',
      'panel.retry': '重试',
      'slider.aria': '温度值',
    }

    const en = {
      'button.aria': 'Sampling temperature',
      'button.auto': 'Auto',
      'panel.title': 'Sampling temperature',
      'panel.hint': 'Applies to every model request sent after this change in this session.',
      'panel.default': 'Model default',
      'panel.loading': 'Loading\u2026',
      'panel.reset': 'Reset to default',
      'panel.retry': 'Retry',
      'slider.aria': 'Temperature value',
    }

    const CSS = `
.dsh-temp-root { position: relative; display: inline-flex; align-items: center; }
.dsh-temp-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 1; cursor: pointer; transition: background-color .12s ease, color .12s ease, border-color .12s ease; }
.dsh-temp-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-temp-btn[data-active="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-temp-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-temp-btn svg { display: block; }
.dsh-temp-panel { position: fixed; z-index: 60; box-sizing: border-box; width: 236px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 10px 28px rgba(0, 0, 0, .18); font-size: 12px; }
.dsh-temp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.dsh-temp-title { font-size: 12px; font-weight: 600; }
.dsh-temp-value { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--dsw-alias-brand-primary); }
.dsh-temp-hint { margin: 0 0 10px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.45; }
.dsh-temp-slider { display: block; width: 100%; margin: 0 0 10px; accent-color: var(--dsw-alias-brand-primary); }
.dsh-temp-presets { display: flex; gap: 6px; }
.dsh-temp-preset { flex: 1 1 0; height: 24px; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.dsh-temp-preset:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-temp-preset[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-temp-preset:disabled { opacity: .5; cursor: default; }
.dsh-temp-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
.dsh-temp-reset { padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11px; cursor: pointer; }
.dsh-temp-reset:disabled { opacity: .5; cursor: default; }
.dsh-temp-error { margin: 8px 0 0; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 1.4; }
.dsh-temp-retry { padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11px; cursor: pointer; }
`

    /**
     * Format one temperature for display: 1 rather than 1.0, 0.7 unchanged.
     * @param {number} value
     */
    function formatValue(value) {
      return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
    }

    /**
     * Read the Host half's state for one session.
     * @param {string} sessionId
     */
    async function readState(sessionId) {
      const response = await fetch(`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return typeof payload.temperature === 'number' ? payload.temperature : null
    }

    /**
     * Write one session's temperature; null clears the override.
     * @param {string} sessionId
     * @param {number | null} temperature
     */
    async function writeState(sessionId, temperature) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId, temperature }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return typeof payload.temperature === 'number' ? payload.temperature : null
    }

    /**
     * @param {{ sessionId?: string, t?: (key: string) => string }} props
     */
    function TemperatureControl(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const sessionId = props.sessionId
      const [value, setValue] = React.useState(null)
      const [loaded, setLoaded] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState(0.7)
      const [anchor, setAnchor] = React.useState(null)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)

      const load = React.useCallback(async () => {
        if (!sessionId) return
        try {
          const next = await readState(sessionId)
          setValue(next)
          if (next !== null) setDraft(next)
          setError(null)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setLoaded(true)
        }
      }, [sessionId])

      const save = React.useCallback(async (next) => {
        if (!sessionId) return
        setBusy(true)
        try {
          const stored = await writeState(sessionId, next)
          setValue(stored)
          if (stored !== null) setDraft(stored)
          setError(null)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      React.useEffect(() => { load() }, [load])

      React.useEffect(() => {
        if (!open) return undefined
        const dismiss = (event) => {
          const panel = panelRef.current
          const button = buttonRef.current
          if (panel && panel.contains(event.target)) return
          if (button && button.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onViewportChange = () => setOpen(false)
        document.addEventListener('pointerdown', dismiss, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', onViewportChange)
        window.addEventListener('scroll', onViewportChange, true)
        return () => {
          document.removeEventListener('pointerdown', dismiss, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', onViewportChange)
          window.removeEventListener('scroll', onViewportChange, true)
        }
      }, [open])

      if (!sessionId) return null

      const label = value === null ? t('button.auto') : formatValue(value)
      const shown = !loaded ? t('panel.loading') : value === null ? t('panel.default') : formatValue(value)

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : undefined
        if (rect) {
          setAnchor({
            right: Math.max(8, window.innerWidth - rect.right),
            bottom: Math.max(8, window.innerHeight - rect.top + 6),
          })
        }
        setOpen(true)
        if (!loaded || error !== null) load()
      }

      const commit = (next) => {
        setDraft(next)
        save(next)
      }

      const style = h('style', { key: 'style' }, CSS)
      const icon = h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          d: 'M8 2.1a1.9 1.9 0 0 1 1.9 1.9v5a3 3 0 1 1-3.8 0v-5A1.9 1.9 0 0 1 8 2.1Z',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linejoin': 'round',
        }),
        h('circle', { cx: 8, cy: 11.4, r: 1.05, fill: 'currentColor' }))

      const button = h('button', {
        ref: buttonRef,
        type: 'button',
        className: 'dsh-temp-btn',
        'data-active': open ? 'true' : 'false',
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': `${t('button.aria')}: ${shown}`,
        title: `${t('panel.title')}: ${shown}`,
        onClick: toggle,
      }, icon, h('span', null, label))

      const root = h('div', { className: 'dsh-temp-root' }, style, button)

      if (!open) return root

      const presets = PRESETS.map((preset) => h('button', {
        key: String(preset),
        type: 'button',
        className: 'dsh-temp-preset',
        'data-selected': value === preset ? 'true' : 'false',
        disabled: busy,
        onClick: () => commit(preset),
      }, formatValue(preset)))

      const panel = h('div', {
        ref: panelRef,
        className: 'dsh-temp-panel',
        role: 'dialog',
        'aria-label': t('panel.title'),
        style: anchor === null ? undefined : { right: `${anchor.right}px`, bottom: `${anchor.bottom}px` },
      },
      h('div', { className: 'dsh-temp-head' },
        h('span', { className: 'dsh-temp-title' }, t('panel.title')),
        h('span', { className: 'dsh-temp-value' }, shown)),
      h('p', { className: 'dsh-temp-hint' }, t('panel.hint')),
      h('input', {
        className: 'dsh-temp-slider',
        type: 'range',
        min: MIN,
        max: MAX,
        step: STEP,
        value: draft,
        disabled: busy,
        'aria-label': t('slider.aria'),
        onChange: (event) => setDraft(Number(event.currentTarget.value)),
        onPointerUp: (event) => commit(Number(event.currentTarget.value)),
        onKeyUp: (event) => {
          const key = event.key
          if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
            commit(Number(event.currentTarget.value))
          }
        },
      }),
      h('div', { className: 'dsh-temp-presets' }, presets),
      h('div', { className: 'dsh-temp-foot' },
        h('button', {
          type: 'button',
          className: 'dsh-temp-reset',
          disabled: busy || value === null,
          onClick: () => save(null),
        }, t('panel.reset'))),
      error === null ? null : h('p', { className: 'dsh-temp-error', role: 'alert' },
        error, ' ',
        h('button', { type: 'button', className: 'dsh-temp-retry', onClick: () => load() }, t('panel.retry'))))

      return h('div', { className: 'dsh-temp-root' }, style, button, panel)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'temperature-control: dictionaries')
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'temperature',
          order: 20,
          locale: LOCALE_NS,
        }, TemperatureControl))
      },
    }
  },
})
