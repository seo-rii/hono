import { Hono } from '../../hono'
import type { Result, Router } from '../../router'
import { UnsupportedPathError } from '../../router'
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

describe.each(builders)('%s embedded-colon safety', (_name, build) => {
  it.each(['/literal/a:b/*', '/literal/a:b/:tail', '/literal/a:b{[0-9]+}/*'])(
    'rejects a newly accepted table containing %s',
    (path) => {
      for (const method of ['GET', 'POST', 'ALL']) {
        const route: Route = [method, path, 'literal']
        for (const routes of [
          [...disjoint, route],
          [route, ...disjoint],
        ]) {
          expect(() => build(routes).match('POST', '/literal/aa/42')).toThrowError(
            new UnsupportedPathError(path)
          )
        }
      }
    }
  )

  it.each(['/literal/:a:b/*', '/literal/:a:b{[a-z]+}/*'])(
    'allows a segment-leading parameter whose name contains a colon in %s',
    (path) => {
      const route: Route = ['POST', path, 'parameter']
      for (const routes of [
        [...disjoint, route],
        [route, ...disjoint],
      ]) {
        expect(normalize(build(routes).match('POST', '/literal/abc/42'))).toEqual([
          ['parameter', { 'a:b': 'abc' }],
        ])
      }
    }
  )

  it('preserves previously supported embedded-colon tables without disjoint branches', () => {
    const router = build([['POST', '/literal/a:b/*', 'legacy']])
    expect(normalize(router.match('POST', '/literal/abc/42'))).toEqual([['legacy', { b: 'bc' }]])
    expect(normalize(router.match('POST', '/literal/a:b/42'))).toEqual([['legacy', { b: ':b' }]])
  })
})

describe('Hono embedded-colon fallback with disjoint branches', () => {
  it.each(['GET', 'POST', 'ALL'])(
    'preserves literal colon matching for %s through Trie fallback',
    async (method) => {
      const route: Route = [method, '/literal/a:b/*', 'literal']
      for (const routes of [
        [...disjoint, route],
        [route, ...disjoint],
      ]) {
        const app = new Hono()
        for (const [method, path, handler] of routes) {
          app.on(method, path, (c) => c.json({ handler, params: c.req.param() }))
        }
        const requestMethod = method === 'ALL' ? 'POST' : method
        expect((await app.request('/literal/aa/42', { method: requestMethod })).status).toBe(404)
        const response = await app.request('/literal/a:b/42', { method: requestMethod })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ handler: 'literal', params: {} })
        expect(app.router.name).toBe('SmartRouter + TrieRouter')
      }
    }
  )
})
