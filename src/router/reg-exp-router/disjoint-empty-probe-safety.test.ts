import { Hono } from '../../hono'
import type { Result, Router } from '../../router'
import { UnsupportedPathError } from '../../router'
import { buildInitParams, PreparedRegExpRouter, serializeInitParams } from './prepared-router'
import { RegExpRouter } from './router'

const disjoint = ['/new/:id{[0-9]+}', '/new/site/:id{[0-9]+}']
const expensivePattern = String.raw`(?:a?|b?){64}\b`
const expensivePath = `/edge/:word{${expensivePattern}}`
const legacyPattern = '[a-z]{2}'
const legacyPath = `/legacy/:word{${legacyPattern}}`
const builders: [string, (paths: string[]) => Router<string>][] = [
  [
    'RegExpRouter',
    (paths) => {
      const router = new RegExpRouter<string>()
      paths.forEach((path) => router.add('GET', path, path))
      return router
    },
  ],
  [
    'serialized PreparedRegExpRouter',
    (paths) => {
      const params = (0, eval)(
        serializeInitParams(buildInitParams({ paths }))
      ) as ConstructorParameters<typeof PreparedRegExpRouter<string>>
      const router = new PreparedRegExpRouter<string>(...params)
      paths.forEach((path) => router.add('GET', path, path))
      return router
    },
  ],
]

function normalize(result: Result<string>) {
  return result[0].map(([handler, params]) => [
    handler,
    Object.fromEntries(
      Object.entries(params).map(([key, index]) => [
        key,
        result[1] ? result[1][index as number] : index,
      ])
    ),
  ])
}

function watchEmptyProbe(pattern: string, reject = false) {
  const originalExec = RegExp.prototype.exec
  let attempts = 0
  // Guard the native execution shared by test() and exec(), without timing
  // assertions or actually evaluating the catastrophic empty-input case.
  const spy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input) {
    if (this.source === pattern && input === '') {
      attempts++
      if (reject) {
        throw new Error('Unproven constraints must not execute before disjoint fallback')
      }
    }
    return originalExec.call(this, input)
  })
  return { spy, attempts: () => attempts }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RegExpRouter empty-input validation after disjoint branches', () => {
  it.each(['GET', 'POST', 'ALL'])(
    'rejects an unproven constraint in %s before its empty-input probe',
    (method) => {
      const router = new RegExpRouter<string>()
      disjoint.forEach((path) => router.add('GET', path, path))
      const guard = watchEmptyProbe(expensivePattern, true)
      expect(() => router.add(method, expensivePath, 'word')).toThrowError(UnsupportedPathError)
      expect(guard.attempts()).toBe(0)
    }
  )

  it.each([false, true])('rejects a Prepared table before probing, reversed pair=%s', (reverse) => {
    const pair = reverse ? [...disjoint].reverse() : disjoint
    const guard = watchEmptyProbe(expensivePattern, true)
    expect(() => buildInitParams({ paths: [...pair, expensivePath] })).toThrowError(
      UnsupportedPathError
    )
    expect(guard.attempts()).toBe(0)
  })

  it('checks copied ALL paths when a new method is created after a disjoint proof', () => {
    const router = new RegExpRouter<string>()
    router.add('ALL', legacyPath, 'legacy')
    router.add('GET', disjoint[0], 'number')
    const guard = watchEmptyProbe(legacyPattern, true)
    expect(() => {
      router.add('GET', disjoint[1], 'site')
      router.add('POST', '/post', 'post')
      router.match('GET', '/new/42')
    }).toThrowError(UnsupportedPathError)
    expect(guard.attempts()).toBe(0)
  })

  it('preserves native SyntaxError for genuine invalid parameter constraints', () => {
    for (const pattern of ['[', '*']) {
      for (const name of ['word', 'a:b']) {
        const router = new RegExpRouter<string>()
        disjoint.forEach((path) => router.add('GET', path, path))
        expect(() => router.add('POST', `/bad/:${name}{${pattern}}`, 'bad')).toThrowError(
          SyntaxError
        )
      }
    }
  })

  it('preserves unrelated errors from constructing an unproven constraint', () => {
    const failure = new Error('regexp constructor failure')
    const NativeRegExp = RegExp
    vi.stubGlobal(
      'RegExp',
      new Proxy(NativeRegExp, {
        construct(target, args, newTarget) {
          if (args[0] === legacyPattern) {
            throw failure
          }
          return Reflect.construct(target, args, newTarget)
        },
      })
    )
    const router = new RegExpRouter<string>()
    disjoint.forEach((path) => router.add('GET', path, path))
    expect(() => router.add('POST', legacyPath, 'legacy')).toThrow(failure)
  })

  it.each([false, true])(
    'keeps registered routes after a rejected empty constraint, proofFirst=%s',
    (proofFirst) => {
      const router = new RegExpRouter<string>()
      router.add('GET', disjoint[0], 'number')
      if (proofFirst) {
        router.add('GET', disjoint[1], 'site')
      }
      expect(() => router.add('GET', '/bad/:x{[a-z]*}', 'bad')).toThrowError(UnsupportedPathError)
      if (!proofFirst) {
        router.add('GET', disjoint[1], 'site')
      }
      expect(normalize(router.match('GET', '/new/42'))).toEqual([['number', { id: '42' }]])
    }
  )
})

describe.each(builders)('%s legacy and in-path empty-input checks', (_name, build) => {
  it('retains validation and matching without a disjoint proof', () => {
    const watch = watchEmptyProbe(legacyPattern)
    const router = build([legacyPath])
    expect(normalize(router.match('GET', '/legacy/ab'))).toEqual([[legacyPath, { word: 'ab' }]])
    expect(router.match('GET', '/legacy/a')[0]).toEqual([])
    expect(watch.attempts()).toBeGreaterThan(0)
  })

  it('retains legacy validation before a later disjoint proof', () => {
    const watch = watchEmptyProbe(legacyPattern)
    expect(() => build([legacyPath, ...disjoint]).match('GET', '/new/42')).toThrowError(
      UnsupportedPathError
    )
    expect(watch.attempts()).toBeGreaterThan(0)
  })

  it('uses a proof established earlier in the same path before probing its next constraint', () => {
    const guard = watchEmptyProbe(expensivePattern, true)
    const paths = ['/g/:id{[0-9]+}/fixed', `/g/site/:word{${expensivePattern}}`]
    expect(() => build(paths).match('GET', '/g/site/a')).toThrowError(UnsupportedPathError)
    expect(guard.attempts()).toBe(0)
  })

  it('keeps proven classes, common labels and single-character constraints supported', () => {
    for (const [pattern, value] of [
      ['[a-z]+', 'abc'],
      ['[^/]+', 'abc'],
      ['a', 'a'],
      [String.raw`\d+`, '42'],
    ]) {
      const path = `/edge/:word{${pattern}}`
      const router = build([...disjoint, path])
      expect(normalize(router.match('GET', '/edge/' + value))).toEqual([[path, { word: value }]])
    }
  })
})

describe('Hono fallback before unproven empty-input probes', () => {
  it.each(['GET', 'POST', 'ALL'])('serves normal and constrained %s requests', async (method) => {
    const app = new Hono()
    disjoint.forEach((path) => app.get(path, (c) => c.json(c.req.param())))
    app.on(method, expensivePath, (c) => c.json(c.req.param()))
    const guard = watchEmptyProbe(expensivePattern, true)
    const response = await app.request('/new/42')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: '42' })
    const constrained = await app.request('/edge/a', {
      method: method === 'ALL' ? 'POST' : method,
    })
    expect(constrained.status).toBe(200)
    expect(await constrained.json()).toEqual({ word: 'a' })
    expect(app.router.name).toBe('SmartRouter + TrieRouter')
    expect(guard.attempts()).toBe(0)
  })

  it('serves a path that establishes the disjoint proof before its unproven constraint', async () => {
    const app = new Hono()
    app.get('/g/:id{[0-9]+}/fixed', (c) => c.json(c.req.param()))
    app.get(`/g/site/:word{${expensivePattern}}`, (c) => c.json(c.req.param()))
    const guard = watchEmptyProbe(expensivePattern, true)
    const response = await app.request('/g/site/a')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ word: 'a' })
    expect(app.router.name).toBe('SmartRouter + TrieRouter')
    expect(guard.attempts()).toBe(0)
  })
})
