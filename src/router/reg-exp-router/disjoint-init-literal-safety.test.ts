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
const malformedLiterals = ['[', '*', '[a-']
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

describe.each(builders)('%s initialization of embedded-colon literals', (_name, build) => {
  it.each(malformedLiterals)('rejects the literal %s as an unsupported regexp path', (pattern) => {
    const path = `/literal/a:b{${pattern}}/*`
    for (const paths of [
      [...disjoint.map(([, path]) => path), path],
      [path, ...disjoint.map(([, path]) => path)],
    ]) {
      expect(() => build(paths).match('GET', '/new/42')).toThrowError(
        new UnsupportedPathError(path)
      )
    }
  })

  it.each(malformedLiterals)(
    'preserves SyntaxError for a real %s parameter constraint',
    (pattern) => {
      for (const name of ['id', 'a:b']) {
        expect(() => build([`/real/:${name}{${pattern}}/*`])).toThrowError(SyntaxError)
      }
    }
  )

  it('preserves previously supported valid embedded-colon constraints', () => {
    const path = '/literal/a:b{[0-9]+}/*'
    const router = build([path])
    expect(normalize(router.match('GET', '/literal/a42/tail'))).toEqual([[path, { b: '42' }]])
  })
})

describe('Hono fallback before malformed literal regexp validation', () => {
  it.each(malformedLiterals)(
    'serves normal and literal requests with %s in a literal',
    async (pattern) => {
      const path = `/literal/a:b{${pattern}}/*`
      const request = '/literal/a:b' + encodeURIComponent(`{${pattern}}`) + '/tail'
      for (const method of ['GET', 'POST', 'ALL']) {
        const literal: Route = [method, path, 'literal']
        for (const pair of [disjoint, [...disjoint].reverse()]) {
          for (const routes of [
            [...pair, literal],
            [literal, ...pair],
          ]) {
            const app = new Hono()
            for (const [method, path, handler] of routes) {
              app.on(method, path, (c) => c.json({ handler, params: c.req.param() }))
            }
            const normal = await app.request('/new/42')
            expect(normal.status).toBe(200)
            expect(await normal.json()).toEqual({ handler: 'number', params: { id: '42' } })
            const response = await app.request(request, {
              method: method === 'ALL' ? 'POST' : method,
            })
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ handler: 'literal', params: {} })
            expect(app.router.name).toBe('SmartRouter + TrieRouter')
          }
        }
      }
    }
  )
})

it('propagates unrelated errors from regexp construction', () => {
  const failure = new Error('constructor failure')
  const NativeRegExp = RegExp
  vi.stubGlobal(
    'RegExp',
    new Proxy(NativeRegExp, {
      construct(target, args, newTarget) {
        if (args[0] === '[') {
          throw failure
        }
        return Reflect.construct(target, args, newTarget)
      },
    })
  )
  try {
    expect(() => new RegExpRouter().add('GET', '/literal/a:b{[}/*', 'literal')).toThrow(failure)
  } finally {
    vi.unstubAllGlobals()
  }
})
