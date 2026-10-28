import { Hono } from '../../hono'
import type { Result } from '../../router'
import { UnsupportedPathError } from '../../router'
import { SmartRouter } from '../smart-router'
import { TrieRouter } from '../trie-router'
import { RegExpRouter } from './router'

type Route = [method: string, path: string, handler: string]

const disjoint: Route[] = [
  ['GET', '/new/:id{[0-9]+}', 'number'],
  ['GET', '/new/site/:id{[0-9]+}', 'site'],
]
const inheritedMethods = ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']

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

describe('RegExpRouter inherited method safety', () => {
  it.each(inheritedMethods)(
    'rejects the unsupported method %s before dictionary lookup',
    (method) => {
      const router = new RegExpRouter<string>()
      const path = '/method/:id'
      expect(() => router.add(method, path, 'edge')).toThrowError(new UnsupportedPathError(path))
    }
  )

  it('preserves supported registrations after rejecting an inherited method', () => {
    const router = new RegExpRouter<string>()
    router.add('GET', '/legacy/:id', 'legacy')
    expect(() => router.add('constructor', '/method/:id', 'edge')).toThrowError(
      UnsupportedPathError
    )
    router.add('POST', '/static', 'static')
    expect(normalize(router.match('GET', '/legacy/42'))).toEqual([['legacy', { id: '42' }]])
    expect(normalize(router.match('POST', '/static'))).toEqual([['static', {}]])
  })

  it.each(inheritedMethods)('accepts the uppercase counterpart of %s', (method) => {
    const router = new RegExpRouter<string>()
    const reference = new TrieRouter<string>()
    const routes: Route[] = [...disjoint, [method.toUpperCase(), '/method/:id', 'edge']]
    for (const route of routes) {
      router.add(...route)
      reference.add(...route)
    }
    expect(normalize(router.match(method.toUpperCase(), '/method/42'))).toEqual(
      normalize(reference.match(method.toUpperCase(), '/method/42'))
    )
    expect(normalize(router.match('GET', '/new/site/42'))).toEqual([['site', { id: '42' }]])
  })
})

describe('SmartRouter method fallback with disjoint branches', () => {
  it.each(inheritedMethods)('preserves Trie fallback for the method %s', (method) => {
    const route: Route = [method, '/method/:id', 'edge']
    for (const routes of [
      [...disjoint, route],
      [route, ...disjoint],
    ]) {
      const router = new SmartRouter<string>({
        routers: [new RegExpRouter(), new TrieRouter()],
      })
      const reference = new TrieRouter<string>()
      for (const route of routes) {
        router.add(...route)
        reference.add(...route)
      }
      for (const [requestMethod, request] of [
        ['GET', '/new/42'],
        ['GET', '/new/site/42'],
        [method, '/method/42'],
        ['POST', '/method/42'],
        ['GET', '/missing'],
      ]) {
        expect(normalize(router.match(requestMethod, request))).toEqual(
          normalize(reference.match(requestMethod, request))
        )
      }
      expect(router.name).toBe('SmartRouter + TrieRouter')
    }
  })

  it('preserves ordinary methods, ALL middleware and tables without disjoint branches', () => {
    const router = new SmartRouter<string>({
      routers: [new RegExpRouter(), new TrieRouter()],
    })
    const routes: Route[] = [
      ['ALL', '*', 'middleware'],
      ['GET', '/legacy/:id', 'legacy'],
      ['CUSTOM', '/static', 'custom'],
    ]
    for (const route of routes) {
      router.add(...route)
    }
    expect(normalize(router.match('GET', '/legacy/42'))).toEqual([
      ['middleware', {}],
      ['legacy', { id: '42' }],
    ])
    expect(normalize(router.match('CUSTOM', '/static'))).toEqual([
      ['middleware', {}],
      ['custom', {}],
    ])
    expect(normalize(router.match('POST', '/missing'))).toEqual([['middleware', {}]])
    expect(router.name).toBe('SmartRouter + RegExpRouter')
  })
})

describe('Hono method normalization with disjoint branches', () => {
  it.each(inheritedMethods)('retains uppercase registration for %s', async (method) => {
    const app = new Hono()
    for (const [method, path, handler] of disjoint) {
      app.on(method, path, (c) => c.text(handler))
    }
    app.on(method, '/method/:id', (c) => c.json({ params: c.req.param() }))
    const response = await app.request('/method/42', { method: method.toUpperCase() })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ params: { id: '42' } })
    expect(app.router.name).toBe('SmartRouter + RegExpRouter')
  })
})
