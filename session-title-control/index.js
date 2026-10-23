/**
 * Retrying session-title provider plus a manual "summarize the title from this
 * session" action.
 *
 * Why a provider: `ctx.sessionTitle` accepts exactly one provider, so this
 * module registers a first-prompt provider that behaves like the built-in one,
 * but retries a failed model call up to `maxAttempts` times before giving up.
 * The built-in row is disabled in the profile patch so the two never collide.
 *
 * Why no `@deepseek-ai/*` imports: a profile `link:` package lives outside the
 * profile directory, and the desktop host's runtime resolver does not map the
 * application's bare specifiers for that root (verified: ERR_MODULE_NOT_FOUND).
 * Everything here therefore goes through `ctx` services and `node:` builtins.
 *
 * Manual path: `refresh()` on the service re-runs the provider over every
 * eligible human message of the live session (plus a short digest of the latest
 * assistant reply). Two surfaces expose it:
 * - `/retitle` command (fire and forget, immediate acknowledgement)
 * - POST /plugin/session-title-control/retitle (awaits, returns the new title)
 *
 * The accepted title is appended by the service as a normal `session/title`
 * event, so the sidebar row updates through the regular client wire. The only
 * event this module appends itself is the best-effort auxiliary request record.
 */

import { randomUUID } from 'node:crypto'

/** Provider identity recorded on every generated title. */
const name = 'session-title-control'

/** Services required before the provider and routes can be installed. */
export const inject = ['sessionTitle', 'llm', 'sessions']

/** Exact route the optional Web half posts to. */
const ROUTE_PATH = '/plugin/session-title-control/retitle'

/** Body cap for the manual route. */
const BODY_LIMIT_BYTES = 16 * 1024

/** Reason code recorded when one attempt exceeds its deadline. */
const TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** Hard cap the title service also enforces. */
const MAX_TITLE_BYTES = 80

/** Default retry policy when the patch omits the knobs. */
const RETRY_DEFAULTS = { maxAttempts: 5, retryBaseDelayMs: 500, retryMaxDelayMs: 8000 }

/** Largest timer Node accepts. */
const MAX_TIMER_DELAY_MS = 2147483647

/**
 * Validate the whole plugin configuration once at load time.
 * @param {Record<string, unknown>} config - untrusted loader configuration.
 */
function resolveConfig(config) {
  const candidate = config ?? {}
  const positive = (key) => {
    const value = candidate[key]
    if (!Number.isInteger(value) || value <= 0) throw new Error(`session-title-control: ${key} must be a positive integer`)
    return value
  }
  const maxInputBytes = positive('maxInputBytes')
  const maxOutputTokens = positive('maxOutputTokens')
  const timeoutMs = positive('timeoutMs')
  if (timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`session-title-control: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  const targetWords = positive('targetWords')
  const targetCjkCharacters = positive('targetCjkCharacters')
  const maxAttempts = candidate.maxAttempts ?? RETRY_DEFAULTS.maxAttempts
  const retryBaseDelayMs = candidate.retryBaseDelayMs ?? RETRY_DEFAULTS.retryBaseDelayMs
  const retryMaxDelayMs = candidate.retryMaxDelayMs ?? RETRY_DEFAULTS.retryMaxDelayMs
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('session-title-control: maxAttempts must be an integer between 1 and 10')
  if (!Number.isInteger(retryBaseDelayMs) || retryBaseDelayMs < 0) throw new Error('session-title-control: retryBaseDelayMs must be a non-negative integer')
  if (!Number.isInteger(retryMaxDelayMs) || retryMaxDelayMs < retryBaseDelayMs) throw new Error('session-title-control: retryMaxDelayMs must be an integer not below retryBaseDelayMs')
  const provider = candidate.provider
  const model = candidate.model
  if ((provider === undefined) !== (model === undefined)) throw new Error('session-title-control: provider and model must be supplied together')
  if (provider !== undefined && (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0)) {
    throw new Error('session-title-control: provider and model overrides must be non-empty strings')
  }
  return { targetWords, targetCjkCharacters, maxInputBytes, maxOutputTokens, timeoutMs, provider, model, maxAttempts, retryBaseDelayMs, retryMaxDelayMs }
}

/** Language-aware system instruction for a fresh title. */
function systemPrompt(config) {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
  ].join('\n')
}

/** Asterisk emphasis wrapping a whole line, such as `**Title**`. */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u

/**
 * Take the title from model output: the first non-empty line, without asterisk
 * emphasis that wraps that whole line.
 * @param {string} text
 */
function titleFromOutput(text) {
  const line = text.split(/\r?\n/u).map((item) => item.trim()).find((item) => item.length > 0) ?? ''
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups
  const marker = groups?.marker
  const inner = groups?.inner
  return marker === void 0 || inner === void 0 || inner.includes(marker) ? line : inner
}

/**
 * Trim one UTF-8 string to at most `limit` bytes without splitting a character.
 * @param {string} text
 * @param {number} limit
 */
function truncateUtf8(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > limit) break
    used += size
    out += char
  }
  return `${out}…`
}

/**
 * Final title normalization: one line, no stray whitespace, within the cap.
 * @param {string} title
 */
function normalizeTitle(title) {
  return truncateUtf8(String(title ?? '').replace(/\s+/gu, ' ').trim(), MAX_TITLE_BYTES).trim()
}

/**
 * Select the messages a title call should see: the first prompt plus the most
 * recent prompts, inside the byte budget. The service passes every eligible
 * human message; a long session would otherwise exceed `maxInputBytes` and fail
 * deterministically on every attempt.
 * @param {ReadonlyArray<{ seq: number, text: string }>} messages
 * @param {string | undefined} assistantExcerpt
 * @param {number} maxInputBytes
 */
function buildInput(messages, assistantExcerpt, maxInputBytes) {
  const budget = Math.max(1024, maxInputBytes - 768)
  const picked = []
  const seen = new Set()
  let used = 0
  const push = (message, limit) => {
    if (seen.has(message.seq)) return
    const text = truncateUtf8(message.text, limit)
    const cost = Buffer.byteLength(text, 'utf8') + 48
    if (used + cost > budget) return
    seen.add(message.seq)
    picked.push({ seq: message.seq, text })
    used += cost
  }
  const first = messages[0]
  if (first !== void 0) push(first, 1600)
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const message = messages[index]
    if (message === void 0) continue
    if (assistantExcerpt !== undefined && used + Buffer.byteLength(message.text, 'utf8') > budget - 1200) break
    const before = picked.length
    push(message, 900)
    if (picked.length === before) break
  }
  const ordered = [...picked].sort((left, right) => left.seq - right.seq)
  const omitted = messages.length - ordered.length
  const payload = {
    messages: ordered,
    ...(omitted > 0 ? { omittedMessages: omitted } : {}),
    ...(assistantExcerpt === undefined ? {} : { assistantExcerpt: truncateUtf8(assistantExcerpt, 1200) }),
  }
  return {
    input: `Generate the session title from this JSON object:\n${JSON.stringify(payload)}`,
    messageSeqs: ordered.map((message) => message.seq),
  }
}

/**
 * The most recent assistant text of one session, for topic disambiguation.
 * @param {any} session - live session exposing `snapshotEvents()`.
 */
function latestAssistantExcerpt(session) {
  let excerpt = undefined
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .trim()
    if (text !== '') excerpt = text
  }
  return excerpt
}

/** Abortable sleep used between attempts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A signal that also aborts once `timeoutMs` elapses, plus its cleanup. */
function startDeadline(signal, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason ?? new Error('aborted'))
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    const error = new Error(`session-title-control: title request timed out after ${timeoutMs}ms`)
    error.code = TIMEOUT_CODE
    controller.abort(error)
  }, timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

/** Errors that a retry cannot fix: the input or the configuration is wrong. */
function isPermanent(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /maxInputBytes|no logged request route|at least one source message|must be supplied together|configuration is required|unknown config key/u.test(message)
}

/** Resolve the explicit pair or the exact route captured from `request/header`. */
function resolveRoute(config, request) {
  if (config.provider !== undefined && config.model !== undefined) return { provider: config.provider, model: config.model }
  const logged = request.route ?? request.session.requestHeader?.()?.config
  if (logged === undefined || typeof logged.provider !== 'string' || typeof logged.model !== 'string') {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  return { provider: logged.provider, model: logged.model }
}

/** Minimal text/finish assembly over the raw chunk stream. */
function assembleChunks(chunks) {
  const parts = new Map()
  const order = []
  let finish = undefined
  let sawToolCall = false
  const slot = (index, type) => {
    let part = parts.get(index)
    if (part === undefined) {
      part = { type, text: '', closed: false }
      parts.set(index, part)
      order.push(index)
    }
    return part
  }
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start':
        slot(chunk.index, chunk.blockType)
        break
      case 'text-delta': {
        const part = slot(chunk.index, 'text')
        if (!part.closed) part.text += chunk.text
        break
      }
      case 'reasoning-delta':
        slot(chunk.index, 'reasoning')
        break
      case 'tool-call-delta':
        sawToolCall = true
        slot(chunk.index, 'tool-call')
        break
      case 'block-end': {
        const part = slot(chunk.index, chunk.block?.type ?? 'text')
        if (!part.closed) {
          part.closed = true
          part.block = chunk.block
        }
        break
      }
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  const blocks = []
  for (const index of order) {
    const part = parts.get(index)
    if (part.block !== undefined) {
      blocks.push(part.block)
      if (part.block.type === 'tool-call') sawToolCall = true
      continue
    }
    if (part.type === 'text' && part.text !== '') blocks.push({ type: 'text', text: part.text })
  }
  return { blocks, finish: finish ?? { kind: 'stop' }, sawToolCall }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const titleProvider = name
  /** Sessions whose next generation is a manual retitle (adds an assistant digest). */
  const manualSessions = new WeakSet()

  /**
   * One model attempt: prepare the call, stream it, and derive the title text.
   * @param {any} request - service-owned provider request.
   * @param {{ system: string, input: string, messageSeqs: number[] }} prepared
   * @param {{ provider: string, model: string }} route
   */
  async function runOnce(request, prepared, route) {
    const deadline = startDeadline(request.signal, resolved.timeoutMs)
    let dispatched = false
    try {
      const call = await ctx.llm.prepareCall(
        { provider: route.provider, model: route.model, maxTokens: resolved.maxOutputTokens },
        deadline.signal,
        (controls, model) => {
          const effort = model?.reasoning?.efforts?.[0]?.id
          return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
        },
      )
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prepared.input }],
        source: { kind: 'dsh-session-title-llm' },
      }
      const options = {
        ...call.config,
        messages: [message],
        system: prepared.system,
        sessionId: request.session.id,
        purpose: 'session-title',
        signal: deadline.signal,
      }
      try {
        request.session.append('session/title-llm-request', {
          titleProvider,
          messageSeqs: [...prepared.messageSeqs],
          route,
          system: prepared.system,
          messages: [message],
          maxTokens: resolved.maxOutputTokens,
          ...(call.config.reasoningEffort === undefined ? {} : { reasoningEffort: call.config.reasoningEffort }),
        })
      } catch (error) {
        ctx.logger.warn(`session "${request.session.id}": could not record the title request: ${error instanceof Error ? error.message : String(error)}`)
      }
      const chunks = []
      dispatched = true
      for await (const chunk of call.stream(options)) chunks.push(chunk)
      deadline.signal.throwIfAborted()
      return assembleChunks(chunks)
    } finally {
      deadline.dispose()
      if (!dispatched) {
        // Preparation failed; nothing to clean up beyond the deadline.
      }
    }
  }

  /**
   * Run the model call with retries.
   * @param {any} request - service-owned provider request.
   * @param {boolean} manual - whether this is an explicit manual retitle.
   */
  async function generateTitle(request, manual) {
    const excerpt = manual ? latestAssistantExcerpt(request.session) : undefined
    const { input, messageSeqs } = buildInput(request.messages, excerpt, resolved.maxInputBytes)
    const prepared = { system: systemPrompt(resolved), input, messageSeqs }
    if (messageSeqs.length === 0) throw new Error('session-title-llm: at least one source message is required')
    const inputBytes = Buffer.byteLength(input, 'utf8')
    if (inputBytes > resolved.maxInputBytes) throw new Error(`session-title-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${resolved.maxInputBytes}`)
    const route = resolveRoute(resolved, request)
    let lastError = undefined
    for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
      request.signal.throwIfAborted()
      try {
        const { blocks, finish, sawToolCall } = await runOnce(request, prepared, route)
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          const error = new Error(finish.failure?.message ?? 'session-title-llm: the model call failed')
          error.code = finish.failure?.code
          throw error
        }
        if (finish.kind === 'max-tokens') throw new Error('session-title-llm: title output reached maxOutputTokens')
        if (finish.kind === 'tool-calls' || sawToolCall) throw new Error('session-title-llm: title output must contain text only')
        const title = normalizeTitle(titleFromOutput(
          blocks.filter((block) => block.type === 'text').map((block) => block.text).join(' '),
        ))
        if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
        return { title, messageSeqs, model: route }
      } catch (error) {
        lastError = error
        if (request.signal.aborted || isPermanent(error) || attempt >= resolved.maxAttempts) throw error
        const delay = Math.min(resolved.retryMaxDelayMs, resolved.retryBaseDelayMs * 2 ** (attempt - 1))
        const jittered = Math.round(delay * (0.8 + Math.random() * 0.4))
        ctx.logger.warn(
          `session "${request.session.id}": title attempt ${attempt}/${resolved.maxAttempts} failed (${error instanceof Error ? error.message : String(error)}); retrying in ${jittered}ms`,
        )
        await sleep(jittered, request.signal)
      }
    }
    throw lastError ?? new Error('session-title-control: title generation failed')
  }

  ctx.sessionTitle.register({
    id: titleProvider,
    automatic: 'first-prompt',
    async generate(request) {
      const manual = manualSessions.has(request.session)
      if (manual) manualSessions.delete(request.session)
      return generateTitle(request, manual)
    },
  })

  /**
   * Regenerate the title of one live session from its own content.
   * @param {string} sessionId
   */
  async function retitle(sessionId) {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error('session is not open; open it in the app before regenerating the title')
    manualSessions.add(session)
    try {
      const snapshot = await ctx.sessionTitle.refresh(session)
      if (snapshot === undefined) throw new Error('this session has no human message to summarize yet')
      return snapshot.title
    } finally {
      manualSessions.delete(session)
    }
  }

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'retitle',
      description: 'Regenerate this session title from the conversation content (retries on failure)',
      input: { hint: '' },
      handler: ({ agent }) => {
        const session = ctx.sessions.get(agent.id)
        if (session === undefined) return { kind: 'error', text: 'This session is not live; reopen it and try again.' }
        retitle(agent.id).catch((error) => {
          ctx.logger.warn(`session "${agent.id}": manual retitle failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        return { kind: 'success', text: 'Regenerating this session title from the conversation\u2026' }
      },
    })
  })

  ctx.inject(['webServer'], (scope) => {
    scope.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      async handler(req, res) {
        try {
          const method = req.method ?? 'GET'
          if (method === 'GET' || method === 'HEAD') {
            const sessions = ctx.sessions.list().map((session) => ({
              sessionId: session.id,
              title: ctx.sessionTitle.get(session)?.title ?? null,
            }))
            sendJson(res, 200, { ok: true, sessions })
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
          const title = await retitle(sessionId)
          sendJson(res, 200, { ok: true, sessionId, title })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
  })
}

/** Send one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read one bounded JSON request body. */
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
