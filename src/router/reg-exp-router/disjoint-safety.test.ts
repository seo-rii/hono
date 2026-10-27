import { Hono } from '../../hono'
import type { Router } from '../../router'
import { UnsupportedPathError } from '../../router'
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

const ancestorPatterns = ['.+', '[a-z/]+', '[^0-9]+']
const unrelatedDisjointRoutes: Route[] = [
  ['GET', '/new/:id{[0-9]+}', 'new number'],
  ['GET', '/new/site/:id{[0-9]+}', 'new site'],
]
const unprovenPaths = [
  ['/empty/:id{[a-z]*}', '/empty/'],
  ['/odd|/x/:id{[0-9]+}', '/odd|/x/42'],
  ['/odd@0/x/:id{[0-9]+}', '/odd@0/x/42'],
  ['/odd{2}/x/:id{[0-9]+}', '/odd{2}/x/42'],
  ['/a/*/b', '/a//b'],
  ['/fo*o/:id{[0-9]+}', '/fo*o/42'],
]

describe.each(builders)('%s disjoint branch safety', (_name, build) => {
  describe.each(ancestorPatterns)('shared ancestor %s', (pattern) => {
    it.each([false, true])(
      'rejects branches after a slash-consuming ancestor, reversed=%s',
      (reverse) => {
        const routes: Route[] = [
          ['GET', `/files/:prefix{${pattern}}/:id{[0-9]+}`, 'generic'],
          ['GET', `/files/:prefix{${pattern}}/site/:id{[0-9]+}`, 'site'],
        ]
        expect(() => {
          const router = build(reverse ? [...routes].reverse() : routes)
          router.match('GET', '/files/a/site/42')
        }).toThrowError(UnsupportedPathError)
      }
    )
  })

  describe.each(['ALL', 'GET'])('%s constrained wildcard middleware', (method) => {
    describe.each([0, 1, 2])('middleware insertion index %s', (middlewareIndex) => {
      it.each([false, true])('rejects a parameter/literal prefix alias, reversed=%s', (reverse) => {
        const endpoints: Route[] = [
          ['GET', '/g/:prefix{a}/:id{[0-9]+}', 'number'],
          ['GET', '/g/a/site/:id{[0-9]+}', 'site'],
        ]
        const routes = reverse ? [...endpoints].reverse() : [...endpoints]
        routes.splice(middlewareIndex, 0, [method, '/g/:prefix{a}/*', 'auth'])
        expect(() => {
          const router = build(routes)
          router.match('GET', '/g/a/site/42')
        }).toThrowError(UnsupportedPathError)
      })
    })
  })

  it.each([false, true])(
    'rejects an unsafe middleware alias in another method, disjoint first=%s',
    (disjointFirst) => {
      const unsafe: Route[] = [
        ['POST', '/g/:prefix{a}/*', 'auth'],
        ['POST', '/g/a/site/:id{[0-9]+}', 'site'],
      ]
      const routes = disjointFirst
        ? [...unrelatedDisjointRoutes, ...unsafe]
        : [...unsafe, ...unrelatedDisjointRoutes]
      expect(() => {
        const router = build(routes)
        router.match('POST', '/g/a/site/42')
      }).toThrowError(UnsupportedPathError)
    }
  )

  it.each([false, true])(
    'rejects an unsafe ancestor on an unrelated branch, disjoint first=%s',
    (disjointFirst) => {
      const unsafe: Route[] = [
        ['GET', '/f/:prefix{.+}/bar/foo', 'bar'],
        ['GET', '/f/:prefix{.+}/foo', 'foo'],
      ]
      const routes = disjointFirst
        ? [...unrelatedDisjointRoutes, ...unsafe]
        : [...unsafe, ...unrelatedDisjointRoutes]
      expect(() => {
        const router = build(routes)
        router.match('GET', '/f/a/bar/foo')
      }).toThrowError(UnsupportedPathError)
    }
  )

  describe.each(unprovenPaths)('unproven path %s', (path, requestPath) => {
    it.each([false, true])(
      'rejects unrelated terminal patterns and literal regexp markers, disjoint first=%s',
      (disjointFirst) => {
        const unsafe: Route[] = [['GET', path, 'existing endpoint']]
        const routes = disjointFirst
          ? [...unrelatedDisjointRoutes, ...unsafe]
          : [...unsafe, ...unrelatedDisjointRoutes]
        expect(() => {
          const router = build(routes)
          router.match('GET', requestPath)
        }).toThrowError(UnsupportedPathError)
      }
    )
  })

  it('preserves a complex terminal pattern without new disjoint branches', () => {
    const router = build([['GET', '/letters/:id{[a-z]{2}}', 'letters']])
    const [handlers, stash] = router.match('GET', '/letters/ab')
    expect(handlers.map(([handler]) => handler)).toEqual(['letters'])
    const index = handlers[0][1].id
    expect(stash ? stash[index as number] : index).toBe('ab')
    expect(router.match('GET', '/letters/abc')[0]).toEqual([])
  })

  it('preserves previously supported parameter/literal aliases without disjoint branches', () => {
    const routes: Route[] = [
      ['GET', '/a/c', 'static'],
      ['GET', '/:prefix{a}/b', 'parameter'],
    ]
    for (const ordered of [routes, [...routes].reverse()]) {
      const router = build(ordered)
      expect(router.match('GET', '/a/c')[0].map(([handler]) => handler)).toEqual(['static'])
      const [handlers, stash] = router.match('GET', '/a/b')
      expect(handlers.map(([handler]) => handler)).toEqual(['parameter'])
      const index = handlers[0][1].prefix
      expect(stash ? stash[index as number] : index).toBe('a')
    }
  })

  it.each(ancestorPatterns)(
    'preserves a previously supported %s ancestor without disjoint branches',
    (pattern) => {
      const router = build([['GET', `/files/:prefix{${pattern}}/site/:id{[0-9]+}`, 'site']])
      const [handlers, stash] = router.match('GET', '/files/a/b/site/42')
      expect(handlers.map(([handler]) => handler)).toEqual(['site'])
      const params = Object.fromEntries(
        Object.entries(handlers[0][1]).map(([key, index]) => [
          key,
          stash ? stash[index as number] : index,
        ])
      )
      expect(params).toEqual({ prefix: 'a/b', id: '42' })
    }
  )

  it.each([':prefix', ':prefix{a}', ':prefix{[a-z]+}', ':prefix{\\d+}'])(
    'still allows disjoint children below a non-slash ancestor %s',
    (prefix) => {
      const value = prefix.includes('\\d') ? '7' : 'a'
      const routes: Route[] = [
        ['ALL', `/g/${prefix}/*`, 'auth'],
        ['GET', `/g/${prefix}/:id{[0-9]+}`, 'number'],
        ['GET', `/g/${prefix}/site/:id{[0-9]+}`, 'site'],
      ]
      for (const endpointsReversed of [false, true]) {
        const ordered = endpointsReversed ? [routes[0], routes[2], routes[1]] : routes
        const router = build(ordered)
        const [handlers, stash] = router.match('GET', `/g/${value}/site/42`)
        expect(handlers.map(([handler]) => handler)).toEqual(['auth', 'site'])
        const params = Object.fromEntries(
          Object.entries(handlers[1][1]).map(([key, index]) => [
            key,
            stash ? stash[index as number] : index,
          ])
        )
        expect(params).toEqual({ prefix: value, id: '42' })
      }
    }
  )
})

describe('Hono fallback for unsafe disjoint branches', () => {
  it('does not turn an embedded literal asterisk into a wildcard', async () => {
    for (const disjointFirst of [false, true]) {
      const app = new Hono()
      const unsafe: Route[] = [['GET', '/fo*o/:id{[0-9]+}', 'literal asterisk']]
      const routes = disjointFirst
        ? [...unrelatedDisjointRoutes, ...unsafe]
        : [...unsafe, ...unrelatedDisjointRoutes]
      for (const [method, path, handler] of routes) {
        app.on(method, path, (c) => c.text(handler))
      }
      expect((await app.request('/foXXo/42')).status).toBe(404)
      expect(app.router.name).toBe('SmartRouter + TrieRouter')
    }
  })

  describe.each(unprovenPaths)('unproven path %s', (path, requestPath) => {
    it.each([false, true])(
      'preserves an existing endpoint after unrelated disjoint branches, disjoint first=%s',
      async (disjointFirst) => {
        const app = new Hono()
        const unsafe: Route[] = [['GET', path, 'existing endpoint']]
        const routes = disjointFirst
          ? [...unrelatedDisjointRoutes, ...unsafe]
          : [...unsafe, ...unrelatedDisjointRoutes]
        for (const [method, route, handler] of routes) {
          app.on(method, route, (c) => c.text(handler))
        }
        const response = await app.request(requestPath)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('existing endpoint')
        expect(app.router.name).toBe('SmartRouter + TrieRouter')
      }
    )
  })

  it.each([false, true])(
    'preserves POST access denial after unrelated GET branches, disjoint first=%s',
    async (disjointFirst) => {
      const app = new Hono()
      const unsafe: Route[] = [
        ['POST', '/g/:prefix{a}/*', 'auth'],
        ['POST', '/g/a/site/:id{[0-9]+}', 'site'],
      ]
      const routes = disjointFirst
        ? [...unrelatedDisjointRoutes, ...unsafe]
        : [...unsafe, ...unrelatedDisjointRoutes]
      for (const [method, path, handler] of routes) {
        app.on(method, path, (c) => (handler === 'auth' ? c.text('blocked', 403) : c.text(handler)))
      }
      const response = await app.request('/g/a/site/42', { method: 'POST' })
      expect(response.status).toBe(403)
      expect(await response.text()).toBe('blocked')
      expect(app.router.name).toBe('SmartRouter + TrieRouter')
    }
  )

  it.each([false, true])(
    'preserves an unrelated ancestor match, disjoint first=%s',
    async (disjointFirst) => {
      const app = new Hono()
      const unsafe: Route[] = [
        ['GET', '/f/:prefix{.+}/bar/foo', 'bar'],
        ['GET', '/f/:prefix{.+}/foo', 'foo'],
      ]
      const routes = disjointFirst
        ? [...unrelatedDisjointRoutes, ...unsafe]
        : [...unsafe, ...unrelatedDisjointRoutes]
      for (const [method, path, handler] of routes) {
        app.on(method, path, (c) => c.json({ handler, params: c.req.param() }))
      }
      const response = await app.request('/f/a/bar/foo')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ handler: 'bar', params: { prefix: 'a' } })
      expect(app.router.name).toBe('SmartRouter + TrieRouter')
    }
  )

  describe.each(ancestorPatterns)('shared ancestor %s', (pattern) => {
    it.each([false, true])(
      'preserves the selected endpoint and parameters, reversed=%s',
      async (reverse) => {
        const app = new Hono()
        const routes = [
          [`/files/:prefix{${pattern}}/:id{[0-9]+}`, 'generic'],
          [`/files/:prefix{${pattern}}/site/:id{[0-9]+}`, 'site'],
        ]
        for (const [path, handler] of reverse ? [...routes].reverse() : routes) {
          app.get(path, (c) => c.json({ handler, params: c.req.param() }))
        }
        const response = await app.request('/files/a/site/42')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          handler: 'site',
          params: { prefix: 'a', id: '42' },
        })
        expect(app.router.name).toBe('SmartRouter + TrieRouter')
      }
    )
  })

  describe.each(['ALL', 'GET'])('%s constrained wildcard middleware', (method) => {
    it.each([false, true])(
      'keeps access denial on an equivalent literal prefix, reversed=%s',
      async (reverse) => {
        const app = new Hono()
        app.on(method, '/g/:prefix{a}/*', (c) => c.text('blocked', 403))
        const routes = [
          ['/g/:prefix{a}/:id{[0-9]+}', 'number'],
          ['/g/a/site/:id{[0-9]+}', 'site'],
        ]
        for (const [path, result] of reverse ? [...routes].reverse() : routes) {
          app.get(path, (c) => c.text(result))
        }
        const response = await app.request('/g/a/site/42')
        expect(response.status).toBe(403)
        expect(await response.text()).toBe('blocked')
        expect(app.router.name).toBe('SmartRouter + TrieRouter')
      }
    )
  })
})
