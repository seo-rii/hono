import { Hono } from '../../hono'
import type { Result, Router } from '../../router'
import { UnsupportedPathError } from '../../router'
import type { H, RouterRoute } from '../../types'
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
      const serialized = serializeInitParams(
        buildInitParams({ paths: [...new Set(routes.map(([, path]) => path))] })
      )
      const params = (0, eval)(serialized) as ConstructorParameters<
        typeof PreparedRegExpRouter<string>
      >
      const router = new PreparedRegExpRouter<string>(...params)
      for (const route of routes) {
        router.add(...route)
      }
      return router
    },
  ],
]

function normalize<T>(result: Result<T>) {
  const [matched, stash] = result
  return matched.map(([handler, params]) => ({
    handler,
    params: Object.fromEntries(
      Object.entries(params)
        .map(([key, value]) => [key, stash ? stash[value as number] : value])
        // HonoRequest.param() also omits undefined wildcard values.
        .filter(([, value]) => value !== undefined)
    ),
  }))
}

describe.each(builders)('%s disjoint constrained branches', (_name, build) => {
  const compare = (routes: Route[], paths: string[]) => {
    const reference = new TrieRouter<string>()
    for (const route of routes) {
      reference.add(...route)
    }
    const router = build(routes)
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS', 'CUSTOM']) {
      for (const path of paths) {
        expect(normalize(router.match(method, path)), `${method} ${path}`).toEqual(
          normalize(reference.match(method, path))
        )
      }
    }
    return router
  }

  it.each([false, true])('allows numeric and static siblings, reversed=%s', (reverse) => {
    const routes: Route[] = [
      ['GET', '/group/:id{[0-9]+}', 'group'],
      ['GET', '/group/site', 'site index'],
      ['GET', '/group/site/:id{[0-9]+}', 'site'],
    ]
    compare(reverse ? [...routes].reverse() : routes, [
      '/group/42',
      '/group/0',
      '/group/0042',
      '/group/site',
      '/group/site/42',
      '/group/site/abc',
      '/group/abc',
      '/group/',
      '/group/42/',
      '/group/site/42/extra',
    ])
  })

  it.each([false, true])(
    'allows nonintersecting numeric and alphabetic patterns, reversed=%s',
    (reverse) => {
      const routes: Route[] = [
        ['GET', '/items/:id{[0-9]+}', 'number'],
        ['GET', '/items/:slug{[a-z]+}', 'slug'],
        ['POST', '/items/:id{[0-9]+}', 'write number'],
        ['GET', '/items/:slug{[a-z]+}/details', 'slug details'],
      ]
      compare(reverse ? [...routes].reverse() : routes, [
        '/items/123',
        '/items/word',
        '/items/word/details',
        '/items/123/details',
        '/items/123abc',
        '/items/Word',
        '/items/',
        '/items/123/',
      ])
    }
  )

  it('preserves wildcard middleware, duplicate handlers, ALL methods and parameter names', () => {
    compare(
      [
        ['ALL', '*', 'global first'],
        ['ALL', '/group/*', 'group first'],
        ['ALL', '/group/:id{[0-9]+}/*', 'numeric middleware'],
        ['GET', '/group/:id{[0-9]+}', 'group first endpoint'],
        ['POST', '/group/:id{[0-9]+}', 'write group'],
        ['GET', '/group/:id{[0-9]+}', 'group second endpoint'],
        ['ALL', '/group/site/:siteId{[0-9]+}/*', 'site middleware'],
        ['GET', '/group/site/:siteId{[0-9]+}', 'site endpoint'],
        ['GET', '/group/site', 'site index'],
        ['ALL', '*', 'global last'],
      ],
      [
        '/group/42',
        '/group/42/deep',
        '/group/site/99',
        '/group/site/99/deep',
        '/group/site',
        '/missing',
      ]
    )
  })

  it.each([
    ['\\d', '7', 'site'],
    ['\\d+', '123', 'site'],
    ['[0-9]', '7', 'site'],
    ['[A-Z]+', 'ABC', 'site'],
    ['[A-Za-z0-9_]+', 'Abc_123', '-special'],
    ['[-0-9]+', '-42', 'site'],
    ['[0-9-]+', '42-', 'site'],
    ['[a-cx-z]+', 'azbycx', 'middle'],
  ])('supports nonempty character atom %s matching %s', (pattern, value, literal) => {
    const routes: Route[] = [
      ['GET', `/items/:value{${pattern}}`, 'parameter'],
      ['GET', `/items/${literal}`, 'literal'],
    ]
    for (const ordered of [routes, [...routes].reverse()]) {
      const router = compare(ordered, [
        `/items/${value}`,
        `/items/${literal}`,
        `/items/${value}/`,
        '/items/',
        '/items/!',
      ])
      expect(normalize(router.match('GET', `/items/${value}`))).toEqual([
        { handler: 'parameter', params: { value } },
      ])
      expect(normalize(router.match('GET', `/items/${literal}`))).toEqual([
        { handler: 'literal', params: {} },
      ])
    }
  })

  it.each([
    ['[0-9]+', '42'],
    ['[a-z]+', 'site'],
    ['[^/]+', 'site'],
    ['[0-9]*', 'site'],
    ['[0-9]?', 'site'],
    ['[0-9]{2}', 'site'],
    ['[0-9]+suffix', 'site'],
    ['[\\d]+', 'site'],
    ['[\\x30-\\x39]+', 'site'],
    ['^[0-9]+$', 'site'],
    ['[0-9]+|site', 'site'],
    ['(?:[0-9]+|site)', 'site'],
    ['(?=site)site', 'site'],
    ['([0-9]+)\\1', 'site'],
  ])('still rejects overlap or unknown syntax %s against %s', (pattern, literal) => {
    const paths = [`/items/:id{${pattern}}`, `/items/${literal}`]
    for (const reversed of [false, true]) {
      const ordered = reversed ? [...paths].reverse() : paths
      expect(() => {
        const router = build(ordered.map((path, index): Route => ['GET', path, String(index)]))
        router.match('GET', `/items/${literal}`)
      }).toThrowError(UnsupportedPathError)
    }
  })

  it('rejects distinct but intersecting constrained branches', () => {
    expect(() => {
      const router = build([
        ['GET', '/items/:number{[0-9]+}', 'number'],
        ['GET', '/items/:hex{[0-9a-f]+}', 'hex'],
      ])
      router.match('GET', '/items/42')
    }).toThrowError(UnsupportedPathError)
  })

  it.each(['|'])(
    'does not classify the single-character metapattern %s as a literal',
    (pattern) => {
      const routes: Route[] = [
        ['GET', `/items/:unknown{${pattern}}`, 'unknown'],
        ['GET', '/items/:id{[0-9]+}', 'number'],
      ]
      for (const ordered of [routes, [...routes].reverse()]) {
        expect(() => {
          const router = build(ordered)
          router.match('GET', '/items/42')
        }).toThrowError(UnsupportedPathError)
      }
    }
  )
})

describe('PreparedRegExpRouter disjoint branches with Hono', () => {
  it('preserves Context, decoded parameters, HEAD and strict trailing slashes after serialization', async () => {
    const paths = ['/group/:id{[0-9]+}', '/group/site/:id{[0-9]+}']
    const params = (0, eval)(
      serializeInitParams(buildInitParams({ paths: ['*', ...paths] }))
    ) as ConstructorParameters<typeof PreparedRegExpRouter<[H, RouterRoute]>>
    const app = new Hono<{ Variables: { viewer: string } }>({
      router: new PreparedRegExpRouter<[H, RouterRoute]>(...params),
    })
    app.use('*', async (c, next) => {
      c.set('viewer', 'same context')
      await next()
      c.header('x-after', 'unwound')
    })
    for (const path of paths) {
      app.get(path, (c) => c.json({ id: c.req.param('id'), viewer: c.get('viewer') }))
    }
    const response = await app.request('/group/site/%34%32')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: '42', viewer: 'same context' })
    expect(response.headers.get('x-after')).toBe('unwound')
    const head = await app.request('/group/42', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await app.request('/group/42/')).status).toBe(404)
    expect((await app.request('/group/site/not-numeric')).status).toBe(404)
  })
})
