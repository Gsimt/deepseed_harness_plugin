/**
 * Client half of @local/session-title-control.
 *
 * One compact button in the conversation header regenerates the current
 * session title from its own content. It talks to the Host half over one exact
 * same-origin route; the accepted title arrives back through the normal
 * `session/title` event, so nothing here has to refresh a store.
 *
 * No Harness Client package is imported: only React and the theme tokens are
 * shared with the surrounding application, the same contract the temperature
 * plugin uses.
 */

window.__ModuleLoader__.load({
  id: '@local/session-title-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LOCALE_NS = 'session-title-control'
    const ENDPOINT = '/plugin/session-title-control/retitle'

    const zh = {
      'button.label': '重排标题',
      'button.busy': '生成中…',
      'button.title': '根据当前会话内容重新生成标题（失败会自动重试）',
      'button.failed': '生成失败',
      'button.retry': '再试',
    }

    const en = {
      'button.label': 'Retitle',
      'button.busy': 'Retitling…',
      'button.title': 'Regenerate this session title from its content (retries on failure)',
      'button.failed': 'Retitle failed',
      'button.retry': 'Retry',
    }

    const CSS = `
.dsh-retitle-root { display: inline-flex; align-items: center; gap: 6px; }
.dsh-retitle-btn { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 1; cursor: pointer; transition: background-color .12s ease, color .12s ease, border-color .12s ease; }
.dsh-retitle-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-retitle-btn:disabled { opacity: .6; cursor: default; }
.dsh-retitle-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-retitle-error { color: var(--dsw-alias-state-error-primary); font-size: 11px; }
.dsh-retitle-error button { margin-left: 4px; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 11px; cursor: pointer; }
`

    /**
     * Ask the Host half to regenerate one session title.
     * @param {string} sessionId
     */
    async function retitle(sessionId) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
      }
      return typeof payload.title === 'string' ? payload.title : ''
    }

    /**
     * @param {{ sessionId?: string, t?: (key: string) => string }} props
     */
    function RetitleButton(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const sessionId = props.sessionId
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      if (!sessionId) return null

      const run = async () => {
        setBusy(true)
        setError(null)
        try {
          await retitle(sessionId)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }

      const button = h('button', {
        type: 'button',
        className: 'dsh-retitle-btn',
        disabled: busy,
        title: error === null ? t('button.title') : `${t('button.failed')}: ${error}`,
        onClick: () => {
          if (!busy) run()
        },
      }, busy ? t('button.busy') : t('button.label'))

      const failure = error === null ? null : h('span', { className: 'dsh-retitle-error', role: 'alert' },
        t('button.failed'),
        h('button', { type: 'button', disabled: busy, onClick: () => run() }, t('button.retry')))

      return h('span', { className: 'dsh-retitle-root' },
        h('style', null, CSS),
        button,
        failure)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'session-title-control: dictionaries')
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'retitle',
          order: 30,
          locale: LOCALE_NS,
        }, RetitleButton))
      },
    }
  },
})
