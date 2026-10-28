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

describe.each(builders)('%s multiple-star safety', (_name, build) => {
  it.each(['**', 'a**'])('rejects a newly accepted table containing %s', (segment) => {
    const path = `/v/${segment}/*`
    for (const method of ['GET', 'POST']) {
      const route: Route = [method, path, 'endpoint']
      for (const routes of [
        [...disjoint, route],
        [route, ...disjoint],
      ]) {
        expect(() => build(routes).match(method, '/v/*/42')).toThrowError(
          new UnsupportedPathError(path)
        )
      }
    }
  })

  it.each(['**', 'a**'])('preserves previously supported %s tables', (segment) => {
    const path = `/v/${segment}/*`
    const router = build([['POST', path, 'endpoint']])
    for (const value of [segment, segment.slice(0, -1), segment.slice(0, -1) + 'extra']) {
      expect(normalize(router.match('POST', `/v/${value}/42`))).toEqual([['endpoint', {}]])
    }
  })

  it.each(['/v/*', '/v/x*/*', '/v/*/fixed/*'])(
    'preserves valid wildcard branches %s with disjoint siblings',
    (path) => {
      const routes: Route[] = [['ALL', path, 'wildcard'], ...disjoint]
      const router = build(routes)
      const reference = new TrieRouter<string>()
      for (const route of routes) {
        reference.add(...route)
      }
      for (const method of ['GET', 'POST']) {
        for (const request of [
          '/new/42',
          '/new/site/42',
          '/v',
          '/v/x',
          '/v/xy/42',
          '/v/a/fixed/42',
          '/v//fixed/42',
          '/missing',
        ]) {
          expect(normalize(router.match(method, request))).toEqual(
            normalize(reference.match(method, request))
          )
        }
      }
    }
  )

  it('preserves a regexp quantifier inside a parameter', () => {
    const router = build([['GET', '/regex/:value{a*b}', 'endpoint']])
    for (const value of ['b', 'ab', 'aaab']) {
      expect(normalize(router.match('GET', '/regex/' + value))).toEqual([['endpoint', { value }]])
    }
  })
})

describe('Hono multiple-star fallback with disjoint branches', () => {
  it.each(['**', 'a**'])('preserves literal segment %s through Trie fallback', async (segment) => {
    for (const method of ['GET', 'POST']) {
      const route: Route = [method, `/v/${segment}/*`, 'endpoint']
      for (const routes of [
        [...disjoint, route],
        [route, ...disjoint],
      ]) {
        const app = new Hono()
        for (const [method, path, handler] of routes) {
          app.on(method, path, (c) => c.text(handler))
        }
        for (const value of [segment.slice(0, -1), segment.slice(0, -1) + 'extra']) {
          expect((await app.request(`/v/${value}/42`, { method })).status).toBe(404)
        }
        const response = await app.request(`/v/${segment}/42`, { method })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('endpoint')
        expect(app.router.name).toBe('SmartRouter + TrieRouter')
      }
    }
  })
})
