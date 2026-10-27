import { Hono } from '../../hono'
import type { Result, Router } from '../../router'
import { UnsupportedPathError } from '../../router'
import { TrieRouter } from '../trie-router'
import { buildInitParams, PreparedRegExpRouter, serializeInitParams } from './prepared-router'
import { RegExpRouter } from './router'

type Route = [method: string, path: string, handler: string]

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

const disjoint: Route[] = [
  ['GET', '/new/:id{[0-9]+}', 'number'],
  ['GET', '/new/site/:id{[0-9]+}', 'site'],
]
const ancestorPatterns = ['.+', '[a-z/]+', '[^0-9]+']
const unprovenPaths = [
  ['/letters/:id{[a-z]{2}}', '/letters/ab'],
  ['/odd|/x/:id{[0-9]+}', '/odd|/x/42'],
  ['/odd@0/x/:id{[0-9]+}', '/odd@0/x/42'],
  ['/odd{2}/x/:id{[0-9]+}', '/odd{2}/x/42'],
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

describe.each(builders)('%s disjoint branch safety', (_name, build) => {
  it.each(ancestorPatterns)(
    'rejects disjoint children below an unproven ancestor %s',
    (pattern) => {
      const routes: Route[] = [
        ['GET', `/files/:prefix{${pattern}}/:id{[0-9]+}`, 'generic'],
        ['GET', `/files/:prefix{${pattern}}/site/:id{[0-9]+}`, 'site'],
      ]
      for (const ordered of [routes, [...routes].reverse()]) {
        expect(() => build(ordered).match('GET', '/files/a/site/42')).toThrowError(
          UnsupportedPathError
        )
      }
    }
  )

  it.each([false, true])(
    'checks unrelated branches in other methods, disjoint first=%s',
    (disjointFirst) => {
      const unsafe: Route[] = [
        ['POST', '/f/:prefix{.+}/bar/foo', 'bar'],
        ['POST', '/f/:prefix{.+}/foo', 'foo'],
      ]
      const routes = disjointFirst ? [...disjoint, ...unsafe] : [...unsafe, ...disjoint]
      expect(() => build(routes).match('POST', '/f/a/bar/foo')).toThrowError(UnsupportedPathError)
    }
  )

  it.each(unprovenPaths)(
    'rejects an unproven path %s in a newly accepted table',
    (path, request) => {
      const route: Route = ['GET', path, 'existing']
      for (const ordered of [
        [route, ...disjoint],
        [...disjoint, route],
      ]) {
        expect(() => build(ordered).match('GET', request)).toThrowError(UnsupportedPathError)
      }
    }
  )

  it('preserves previously supported complex patterns without disjoint branches', () => {
    const router = build([['GET', '/letters/:id{[a-z]{2}}', 'letters']])
    expect(normalize(router.match('GET', '/letters/ab'))).toEqual([['letters', { id: 'ab' }]])
    expect(router.match('GET', '/letters/abc')[0]).toEqual([])
  })

  it.each([':prefix', ':prefix{a}', ':prefix{[a-z]+}', ':prefix{\\d+}'])(
    'allows disjoint children below a non-slash ancestor %s',
    (prefix) => {
      const value = prefix.includes('\\d') ? '7' : 'a'
      const routes: Route[] = [
        ['ALL', `/g/${prefix}/*`, 'auth'],
        ['GET', `/g/${prefix}/:id{[0-9]+}`, 'number'],
        ['GET', `/g/${prefix}/site/:id{[0-9]+}`, 'site'],
      ]
      const reference = new TrieRouter<string>()
      for (const route of routes) {
        reference.add(...route)
      }
      for (const ordered of [routes, [routes[0], routes[2], routes[1]]]) {
        const router = build(ordered)
        expect(normalize(router.match('GET', `/g/${value}/site/42`))).toEqual(
          normalize(reference.match('GET', `/g/${value}/site/42`))
        )
      }
    }
  )

  it('preserves upstream middleware captures on equivalent literal prefixes', () => {
    const routes: Route[] = [
      ['ALL', '/g/:prefix{a}/*', 'auth'],
      ['GET', '/g/:prefix{a}/:id{[0-9]+}', 'number'],
      ['GET', '/g/a/site/:id{[0-9]+}', 'site'],
    ]
    for (const ordered of [routes, [routes[0], routes[2], routes[1]]]) {
      expect(normalize(build(ordered).match('GET', '/g/a/site/42'))).toEqual([
        ['auth', { prefix: 'a' }],
        ['site', { id: '42' }],
      ])
    }
  })

  it('preserves upstream middle-wildcard coverage with disjoint branches', () => {
    const routes: Route[] = [
      ['ALL', '/g/*/fixed/*', 'auth'],
      ['GET', '/g/:prefix/fixed/:id{[0-9]+}', 'number'],
      ['GET', '/g/:prefix/fixed/site/:id{[0-9]+}', 'site'],
    ]
    const reference = new TrieRouter<string>()
    for (const route of routes) {
      reference.add(...route)
    }
    const router = build(routes)
    for (const path of ['/g/a/fixed/42', '/g/a/fixed/site/42', '/g//fixed/site/42']) {
      expect(normalize(router.match('GET', path))).toEqual(normalize(reference.match('GET', path)))
    }
  })
})

describe('Hono with disjoint branches', () => {
  it('retains upstream access denial on equivalent literal prefixes', async () => {
    const app = new Hono()
    app.use('/g/:prefix{a}/*', async (c) => c.text('blocked', 403))
    app.get('/g/:prefix{a}/:id{[0-9]+}', (c) => c.text('number'))
    app.get('/g/a/site/:id{[0-9]+}', (c) => c.text('site'))
    const response = await app.request('/g/a/site/42')
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('blocked')
    expect(app.router.name).toBe('SmartRouter + RegExpRouter')
  })

  it.each([false, true])(
    'falls back for an unrelated slash-consuming ancestor, disjoint first=%s',
    async (disjointFirst) => {
      const app = new Hono()
      const unsafe: Route[] = [
        ['POST', '/f/:prefix{.+}/bar/foo', 'bar'],
        ['POST', '/f/:prefix{.+}/foo', 'foo'],
      ]
      const routes = disjointFirst ? [...disjoint, ...unsafe] : [...unsafe, ...disjoint]
      for (const [method, path, handler] of routes) {
        app.on(method, path, (c) => c.json({ handler, params: c.req.param() }))
      }
      const response = await app.request('/f/a/bar/foo', { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ handler: 'bar', params: { prefix: 'a' } })
      expect(app.router.name).toBe('SmartRouter + TrieRouter')
    }
  )
})
