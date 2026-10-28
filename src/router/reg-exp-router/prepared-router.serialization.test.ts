import { Hono } from '../../hono'
import type { Result } from '../../router'
import { TrieRouter } from '../trie-router'
import { buildInitParams, PreparedRegExpRouter, serializeInitParams } from './prepared-router'

type InitParams = ConstructorParameters<typeof PreparedRegExpRouter>
type HonoHandler = Parameters<Hono['router']['add']>[2]

async function loadInitializer(source: string): Promise<() => InitParams> {
  const url = 'data:text/javascript,' + encodeURIComponent('export default () => ' + source)
  const module = await import(/* @vite-ignore */ url)
  return module.default
}

function normalize<T>(result: Result<T>) {
  return result[0].map(([handler, params]) => [
    handler,
    Object.fromEntries(
      Object.entries(params)
        .map(([key, value]) => [key, result[1] ? result[1][value as number] : value])
        .filter(([, value]) => value !== undefined)
    ),
  ])
}

describe('serialized PreparedRegExpRouter initializers', () => {
  it('preserves escaped quotes when loading the initializer as ESM', async () => {
    const route = String.raw`/a/:x{\"}`
    const create = await loadInitializer(serializeInitParams(buildInitParams({ paths: [route] })))
    const params = create() as ConstructorParameters<typeof PreparedRegExpRouter<HonoHandler>>
    const apps = [
      new Hono({ router: new TrieRouter() }),
      new Hono({ router: new PreparedRegExpRouter(...params) }),
    ]
    for (const app of apps) {
      app.get(route, (c) => c.json(c.req.param()))
    }
    for (const [path, status] of [
      ['/a/%22', 200],
      ['/a/%5C%22', 404],
    ] as const) {
      for (const app of apps) {
        const response = await app.request(path)
        expect(response.status).toBe(status)
        if (status === 200) {
          expect(await response.json()).toEqual({ x: '"' })
        }
      }
    }
  })

  it('does not add backslashes to a quoted character class', async () => {
    const route = String.raw`/class/:x{[a\"b]+}`
    const create = await loadInitializer(serializeInitParams(buildInitParams({ paths: [route] })))
    const params = create() as ConstructorParameters<typeof PreparedRegExpRouter<HonoHandler>>
    const apps = [
      new Hono({ router: new TrieRouter() }),
      new Hono({ router: new PreparedRegExpRouter(...params) }),
    ]
    for (const app of apps) {
      app.get(route, (c) => c.json(c.req.param()))
    }
    for (const [value, status] of [
      ['a', 200],
      ['b', 200],
      ['%22', 200],
      ['%5C', 404],
      ['a%5Cb', 404],
    ] as const) {
      for (const app of apps) {
        const response = await app.request('/class/' + value)
        expect(response.status).toBe(status)
        if (status === 200) {
          expect(await response.json()).toEqual({ x: decodeURIComponent(value) })
        }
      }
    }
  })

  it('preserves regexp flags, undefined captures, marker-like strings and own keys', async () => {
    const params = buildInitParams({
      paths: ['/before/:id', '/prefix/:p{a}/*', '/prefix/a/site'],
    })
    const matcher = params[0].ALL!
    expect(matcher[2]['/prefix/a/site'][1]).toContain(undefined)
    matcher[0] = new RegExp(String.raw`^\/(?:"|\\|\n|\u2028)$`, 'gimsuy')
    matcher[2]['/literal-markers'] = [[], ['##undefined##', '##/^a$/##', '##42##']]
    Object.defineProperty(matcher[2], '__proto__', { value: [[], []], enumerable: true })
    const create = await loadInitializer(serializeInitParams(params))
    const copy = create()
    expect(copy).toEqual(params)
    expect(copy[0].ALL![0].source).toBe(matcher[0].source)
    expect(copy[0].ALL![0].flags).toBe(matcher[0].flags)
    expect(Object.hasOwn(copy[0].ALL![2], '__proto__')).toBe(true)
    expect(copy[0].ALL![2]['/literal-markers'][1]).toEqual(['##undefined##', '##/^a$/##', '##42##'])
  })

  it('creates independent handler tables and preserves retained request captures', async () => {
    const paths = ['/before/:id', '/prefix/:p{a}/*', '/prefix/a/site']
    const create = await loadInitializer(serializeInitParams(buildInitParams({ paths })))
    const first = new PreparedRegExpRouter(...create())
    const second = new PreparedRegExpRouter(...create())
    for (const [router, label] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      router.add('GET', '/before/:id', label + '-before')
      router.add('ALL', '/prefix/:p{a}/*', label + '-middleware')
      router.add('GET', '/prefix/a/site', label + '-site')
    }
    expect(normalize(first.match('GET', '/prefix/a/site'))).toEqual([
      ['first-middleware', { p: 'a' }],
      ['first-site', {}],
    ])
    expect(normalize(second.match('GET', '/prefix/a/site'))).toEqual([
      ['second-middleware', { p: 'a' }],
      ['second-site', {}],
    ])
    const retained = first.match('GET', '/prefix/a/site')
    const snapshot = structuredClone(normalize(retained))
    first.match('GET', '/before/42')
    expect(normalize(retained)).toEqual(snapshot)
  })
})
