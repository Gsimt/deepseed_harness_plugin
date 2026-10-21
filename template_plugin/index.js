/**
 * Host half of the sampling-temperature plugin.
 *
 * State: one temperature override per Session, held in memory. It is a UI
 * preference, not model-visible content, so it never enters the session log.
 *
 * Application: the `agent/request` waterfall runs once per model call. After
 * `next()` yields the frozen call configuration, a Session with an override
 * gets a replacement carrying `temperature`. Sessions with no override are
 * left exactly as the agent loop decided.
 *
 * Surfaces:
 * - `ctx.commands`: `/temperature [0-2|default]`, a UI-less path and discovery hint.
 * - an exact Web route the Client half reads and writes.
 */

const ROUTE_PATH = '/plugin/temperature-control/state'
const MIN_TEMPERATURE = 0
const MAX_TEMPERATURE = 2
const BODY_LIMIT_BYTES = 16 * 1024

/**
 * Normalize one submitted temperature. Returns the rounded value, or null when
 * the input is not a finite number (callers distinguish "clear" before calling).
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeTemperature(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return null
  const clamped = Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, numeric))
  return Math.round(clamped * 10) / 10
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read one bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('request body must be JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** @type {Map<string, number>} */
  const overrides = new Map()
  /** @type {Map<string, { temperature: number, at: number, provider: string, model: string }>} */
  const lastApplied = new Map()

  /**
   * @param {string} sessionId
   */
  function stateOf(sessionId) {
    return {
      sessionId,
      temperature: overrides.has(sessionId) ? overrides.get(sessionId) : null,
      lastApplied: lastApplied.get(sessionId) ?? null,
    }
  }

  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const sessionId = payload.agent.id
    const temperature = overrides.get(sessionId)
    if (temperature === undefined) return config
    lastApplied.set(sessionId, {
      temperature,
      at: Date.now(),
      provider: config.provider,
      model: config.model,
    })
    if (config.temperature === temperature) return config
    return { ...config, temperature }
  })

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'temperature',
      description: 'Set this session\u2019s sampling temperature (0\u20132), or reset it to the model default',
      input: { hint: '0.7 | default' },
      handler: ({ agent, rawInput }) => {
        const sessionId = agent.id
        const raw = String(rawInput ?? '').trim().toLowerCase()
        if (raw === 'default' || raw === 'reset' || raw === 'off') {
          overrides.delete(sessionId)
          return { kind: 'success', text: 'Sampling temperature reset to the model default.' }
        }
        if (raw === '' || raw === 'status') {
          const current = overrides.get(sessionId)
          return {
            kind: 'success',
            text: current === undefined
              ? `Sampling temperature: model default (${MIN_TEMPERATURE}\u2013${MAX_TEMPERATURE} accepted).`
              : `Sampling temperature: ${current} for this session.`,
          }
        }
        const next = normalizeTemperature(raw)
        if (next === null) {
          return { kind: 'error', text: `Expected a number between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}, or "default".` }
        }
        overrides.set(sessionId, next)
        return { kind: 'success', text: `Sampling temperature set to ${next} for this session.` }
      },
    })
  })

  ctx.inject(['webServer'], (scope) => {
    scope.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      /**
       * @param {import('node:http').IncomingMessage} req
       * @param {import('node:http').ServerResponse} res
       */
      handler: async (req, res) => {
        try {
          const method = req.method ?? 'GET'
          const url = new URL(req.url ?? '/', 'http://localhost')
          const querySession = (url.searchParams.get('sessionId') ?? '').trim()

          if (method === 'GET' || method === 'HEAD') {
            if (querySession !== '') {
              sendJson(res, 200, { ok: true, ...stateOf(querySession) })
              return
            }
            sendJson(res, 200, {
              ok: true,
              sessions: [...overrides.entries()].map(([sessionId, temperature]) => ({ sessionId, temperature })),
              lastApplied: [...lastApplied.entries()].map(([sessionId, applied]) => ({ sessionId, ...applied })),
            })
            return
          }

          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'only GET and POST are supported' })
            return
          }

          const payload = await readJsonBody(req)
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
          if (sessionId === '') {
            sendJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }

          const submitted = payload.temperature
          if (submitted === null || submitted === undefined) {
            overrides.delete(sessionId)
            sendJson(res, 200, { ok: true, ...stateOf(sessionId) })
            return
          }
          const temperature = normalizeTemperature(submitted)
          if (temperature === null) {
            sendJson(res, 400, { ok: false, error: `temperature must be a number between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}, or null` })
            return
          }
          overrides.set(sessionId, temperature)
          sendJson(res, 200, { ok: true, ...stateOf(sessionId) })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })
}
