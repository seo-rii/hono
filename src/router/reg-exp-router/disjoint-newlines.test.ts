import { Hono } from '../../hono'
import type { Result, Router } from '../../router'
import type { H, RouterRoute } from '../../types'
import { TrieRouter } from '../trie-router'
import { buildInitParams, PreparedRegExpRouter, serializeInitParams } from './prepared-router'
import { RegExpRouter } from './router'

type Route = [method: string, path: string, handler: string]
type RouterName = 'RegExpRouter' | 'PreparedRegExpRouter'

const routerNames: RouterName[] = ['RegExpRouter', 'PreparedRegExpRouter']
const lineTerminators = [
  ['LF', '\n', '%0A'],
  ['CR', '\r', '%0D'],
  ['line separator', '\u2028', '%E2%80%A8'],
  ['paragraph separator', '\u2029', '%E2%80%A9'],
]
const disjointRoutes: Route[] = [
  ['GET', '/group/:id{[0-9]+}', 'number'],
  ['GET', '/group/site/:id{[0-9]+}', 'site'],
]

function createRouter<T>(name: RouterName, paths: string[]): Router<T> {
  if (name === 'RegExpRouter') {
    return new RegExpRouter<T>()
  }
  const params = (0, eval)(
    serializeInitParams(buildInitParams({ paths: [...new Set(paths)] }))
  ) as ConstructorParameters<typeof PreparedRegExpRouter<T>>
  return new PreparedRegExpRouter<T>(...params)
}

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

function compare(name: RouterName, routes: Route[], requests: string[]) {
  const router = createRouter<string>(
    name,
    routes.map(([, path]) => path)
  )
  const reference = new TrieRouter<string>()
  for (const route of routes) {
    router.add(...route)
    reference.add(...route)
  }
  for (const method of ['GET', 'POST', 'HEAD']) {
    for (const path of requests) {
      expect(normalize(router.match(method, path)), `${method} ${JSON.stringify(path)}`).toEqual(
        normalize(reference.match(method, path))
      )
    }
  }
  return router
}

describe.each(routerNames)('%s line terminators in disjoint tables', (name) => {
  describe.each(lineTerminators)('%s', (_label, character) => {
    it.each(['*', '/protected/*'])('matches %s middleware on line terminators', (wildcard) => {
      const root = wildcard === '*' ? '' : '/protected'
      const middleware: Route = ['ALL', wildcard, 'auth']
      for (const middlewareFirst of [false, true]) {
        const routes = middlewareFirst
          ? [middleware, ...disjointRoutes]
          : [...disjointRoutes, middleware]
        const router = compare(name, routes, [
          `${root}/missing${character}x`,
          `${root}/missing${character}`,
          `${root}/${character}`,
          `${root}/missing`,
        ])
        expect(normalize(router.match('POST', `${root}/missing${character}x`))).toEqual([
          ['auth', {}],
        ])
      }
    })

    it.each([false, true])('keeps literal line terminators, disjoint first=%s', (disjointFirst) => {
      const path = `/a${character}b/:id{[0-9]+}`
      const literal: Route = ['GET', path, 'literal']
      const routes = disjointFirst ? [...disjointRoutes, literal] : [literal, ...disjointRoutes]
      const router = compare(name, routes, [`/a${character}b/42`, '/ab/42'])
      expect(normalize(router.match('GET', `/a${character}b/42`))).toEqual([
        ['literal', { id: '42' }],
      ])
      expect(router.match('GET', '/ab/42')[0]).toEqual([])
    })

    it.each(['*', '/protected/*'])(
      'propagates %s middleware to a literal newline endpoint in both registration orders',
      (wildcard) => {
        const root = wildcard === '*' ? '' : '/protected'
        const endpoint: Route = ['GET', `${root}/a${character}b/:id{[0-9]+}`, 'literal']
        const middleware: Route = ['ALL', wildcard, 'auth']
        for (const middlewareFirst of [false, true]) {
          const routes = [
            ...disjointRoutes,
            ...(middlewareFirst ? [middleware, endpoint] : [endpoint, middleware]),
          ]
          const router = compare(name, routes, [`${root}/a${character}b/42`, `${root}/ab/42`])
          expect(router.match('GET', `${root}/a${character}b/42`)[0].map(([h]) => h)).toEqual(
            middlewareFirst ? ['auth', 'literal'] : ['literal', 'auth']
          )
        }
      }
    )
  })
})

describe.each(['Hono', 'PreparedRegExpRouter'])('%s encoded line terminators', (name) => {
  const createApp = (paths: string[]): Hono =>
    name === 'Hono'
      ? new Hono()
      : new Hono({ router: createRouter<[H, RouterRoute]>('PreparedRegExpRouter', paths) })

  describe.each(lineTerminators)('%s', (_label, character, encoded) => {
    it.each(['*', '/protected/*'])(
      'keeps %s access denial before custom notFound',
      async (wildcard) => {
        const app = createApp([wildcard, ...disjointRoutes.map(([, path]) => path)])
        app.use(wildcard, async (c) => c.text('blocked', 403))
        for (const [, path, handler] of disjointRoutes) {
          app.get(path, (c) => c.text(handler))
        }
        app.notFound((c) => c.text('public fallback', 200))
        const root = wildcard === '*' ? '' : '/protected'
        for (const method of ['GET', 'POST', 'HEAD']) {
          for (const suffix of [`missing${encoded}x`, `missing${encoded}`]) {
            const response = await app.request(`${root}/${suffix}`, { method })
            expect(response.status).toBe(403)
            expect(await response.text()).toBe(method === 'HEAD' ? '' : 'blocked')
          }
        }
      }
    )

    it.each([false, true])(
      'preserves encoded literal paths and parameters, disjoint first=%s',
      async (disjointFirst) => {
        const path = `/a${character}b/:id{[0-9]+}`
        const literal: Route = ['GET', path, 'literal']
        const routes = disjointFirst ? [...disjointRoutes, literal] : [literal, ...disjointRoutes]
        const app = createApp(routes.map(([, path]) => path))
        for (const [, path, handler] of routes) {
          app.get(path, (c) => c.json({ handler, id: c.req.param('id') }))
        }
        const response = await app.request(`/a${encoded}b/%34%32`)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ handler: 'literal', id: '42' })
        expect((await app.request('/ab/42')).status).toBe(404)
      }
    )
  })
})
