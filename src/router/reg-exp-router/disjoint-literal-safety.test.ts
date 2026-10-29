import { Hono } from '../../hono'
import type { Result, Router } from '../../router'
import { UnsupportedPathError } from '../../router'
import { TrieRouter } from '../trie-router'
import { buildInitParams, PreparedRegExpRouter, serializeInitParams } from './prepared-router'
import { RegExpRouter } from './router'

type Route = [method: string, path: string, handler: string]

const disjoint: Route[] = [
  ['GET', '/new/:id{[0-9]+}', 'number'],
  ['GET', '/new/site/:id{[0-9]+}', 'site'],
]
const unsafeSegments = ['(a)', '[a]', 'a$', '^a', 'a+b', '^.*', '.+$', '.+\\*']
const compatibleSegments = [
  'a.b',
  'a+',
  'a*',
  '+',
  '(a)*',
  '[a]*',
  '[^]*',
  'a.*',
  '[$]*',
  String.raw`\$*`,
  String.raw`[\]$]*`,
]

const builders: [string, (routes: Route[]) => Router<string>][] = [
  [
    'RegExpRouter',
    (routes) => {
      const router = new RegExpRouter<string>()
      for (const route of routes) {
        router.add(...route)
      }
      return router
    },
  ],
  [
    'PreparedRegExpRouter',
    (routes) => {
      const params = (0, eval)(
        serializeInitParams(buildInitParams({ paths: routes.map(([, path]) => path) }))
      ) as ConstructorParameters<typeof PreparedRegExpRouter<string>>
      const router = new PreparedRegExpRouter<string>(...params)
      for (const route of routes) {
        router.add(...route)
      }
      return router
    },
  ],
]

function normalize(result: Result<string>) {
  return result[0].map(([handler, params]) => [
    handler,
    Object.fromEntries(
      Object.entries(params)
        .map(([key, value]) => [key, result[1] ? result[1][value as number] : value])
        .filter(([, value]) => value !== undefined)
    ),
  ])
}

describe.each(builders)('%s literal segment safety', (_name, build) => {
  it.each(unsafeSegments)(
    'rejects a newly accepted table with literal %s after a constrained parameter',
    (segment) => {
      for (const pattern of ['[0-9]+', '[^/]+', 'a']) {
        const path = `/v/:id{${pattern}}/${segment}`
        const value = pattern === 'a' ? 'a' : '42'
        for (const method of ['GET', 'POST', 'ALL']) {
          const route: Route = [method, path, 'endpoint']
          for (const routes of [
            [...disjoint, route],
            [route, ...disjoint],
          ]) {
            expect(() => build(routes).match(method, `/v/${value}/${segment}`)).toThrowError(
              new UnsupportedPathError(path)
            )
          }
        }
      }
    }
  )

  it.each(unsafeSegments)(
    'preserves previously supported literal %s without disjoint branches',
    (segment) => {
      const router = build([['POST', `/v/:id{[0-9]+}/${segment}`, 'endpoint']])
      expect(normalize(router.match('POST', `/v/42/${segment}`))).toEqual([
        ['endpoint', { id: '42' }],
      ])
    }
  )

  it.each(compatibleSegments)(
    'accepts compatible literal or wildcard %s after a constrained parameter',
    (segment) => {
      const routes: Route[] = [...disjoint, ['POST', `/v/:id{[0-9]+}/${segment}`, 'endpoint']]
      const router = build(routes)
      const reference = new TrieRouter<string>()
      for (const route of routes) {
        reference.add(...route)
      }
      for (const request of [
        `/v/42/${segment}`,
        `/v/42/${segment.endsWith('*') ? segment.slice(0, -1) : segment}`,
        '/v/42/a',
        '/v/42/ab',
        '/v/42/a/extra',
        '/v/not-a-number/a',
        '/missing',
      ]) {
        expect(normalize(router.match('POST', request))).toEqual(
          normalize(reference.match('POST', request))
        )
      }
      expect(normalize(router.match('POST', `/v/42/${segment}`))).toEqual([
        ['endpoint', { id: '42' }],
      ])
    }
  )

  it('rejects an end anchor whose matching depends on a later parameter', () => {
    const path = '/v/:id{[0-9]+}/.+$/tail/:value'
    const routes: Route[] = [...disjoint, ['POST', path, 'endpoint']]
    expect(() => build(routes).match('POST', '/v/42/.+$/tail/a\nb')).toThrowError(
      new UnsupportedPathError(path)
    )
  })

  it('preserves a previously supported end anchor before a later parameter', () => {
    const router = build([['POST', '/v/:id{[0-9]+}/.+$/tail/:value', 'endpoint']])
    expect(normalize(router.match('POST', '/v/42/.+$/tail/a\nb'))).toEqual([
      ['endpoint', { id: '42', value: 'a\nb' }],
    ])
  })

  it.each(unsafeSegments)(
    'accepts literal %s without a preceding constrained parameter',
    (segment) => {
      for (const parameter of ['', ':id/']) {
        const routes: Route[] = [...disjoint, ['POST', `/v/${parameter}${segment}`, 'endpoint']]
        const router = build(routes)
        const request = `/v/${parameter ? '42/' : ''}${segment}`
        expect(normalize(router.match('POST', request))).toEqual([
          ['endpoint', parameter ? { id: '42' } : {}],
        ])
      }
    }
  )
})

describe('Hono literal segment fallback with disjoint branches', () => {
  it.each(['\n', '\r', '\u2028', '\u2029'])(
    'preserves Trie matching when a later parameter contains %j',
    async (lineBreak) => {
      const app = new Hono()
      const reference = new Hono({ router: new TrieRouter() })
      const routes: Route[] = [...disjoint, ['POST', '/v/:id{[0-9]+}/.+$/tail/:value', 'endpoint']]
      for (const target of [app, reference]) {
        for (const [method, path, handler] of routes) {
          target.on(method, path, (c) => c.json({ handler, params: c.req.param() }))
        }
      }
      const request = `/v/42/.+$/tail/a${encodeURIComponent(lineBreak)}b`
      const response = await app.request(request, { method: 'POST' })
      const expected = await reference.request(request, { method: 'POST' })
      expect(expected.status).toBe(404)
      expect(response.status).toBe(expected.status)
      expect(await response.text()).toBe(await expected.text())
      expect(app.router.name).toBe('SmartRouter + TrieRouter')
    }
  )

  it.each(unsafeSegments)(
    'preserves Trie matching for literal %s after a constrained parameter',
    async (segment) => {
      for (const method of ['GET', 'POST', 'ALL']) {
        const route: Route = [method, `/v/:id{[0-9]+}/${segment}`, 'endpoint']
        const requestMethod = method === 'ALL' ? 'POST' : method
        for (const routes of [
          [...disjoint, route],
          [route, ...disjoint],
        ]) {
          const app = new Hono()
          const reference = new Hono({ router: new TrieRouter() })
          for (const target of [app, reference]) {
            for (const [method, path, handler] of routes) {
              target.on(method, path, (c) => c.json({ handler, params: c.req.param() }))
            }
          }
          for (const request of [`/v/42/${segment}`, '/new/42', '/new/site/42']) {
            const response = await app.request(request, { method: requestMethod })
            const expected = await reference.request(request, { method: requestMethod })
            expect(response.status).toBe(expected.status)
            expect(await response.text()).toBe(await expected.text())
          }
          expect(app.router.name).toBe('SmartRouter + TrieRouter')
        }
      }
    }
  )

  it.each(unsafeSegments)(
    'preserves middleware matching for literal %s after a constrained parameter',
    async (segment) => {
      const app = new Hono()
      const reference = new Hono({ router: new TrieRouter() })
      for (const target of [app, reference]) {
        for (const [method, path, handler] of disjoint) {
          target.on(method, path, (c) => c.text(handler))
        }
        target.use(`/v/:id{[0-9]+}/${segment}/*`, async (c) => c.text('blocked', 403))
        target.post('/v/:id{[0-9]+}/*', (c) => c.json({ params: c.req.param() }))
      }
      const response = await app.request(`/v/42/${segment}/extra`, { method: 'POST' })
      const expected = await reference.request(`/v/42/${segment}/extra`, { method: 'POST' })
      expect(response.status).toBe(expected.status)
      expect(await response.text()).toBe(await expected.text())
      expect(app.router.name).toBe('SmartRouter + TrieRouter')
    }
  )
})
