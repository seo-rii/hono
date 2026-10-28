import { Hono } from '../../hono'
import type { Result } from '../../router'
import { UnsupportedPathError } from '../../router'
import { buildInitParams, PreparedRegExpRouter, serializeInitParams } from './prepared-router'
import { RegExpRouter } from './router'

const disjoint = ['/new/:id{[0-9]+}', '/new/site/:id{[0-9]+}']

function guardLiteralLookahead(segment: string) {
  const constructed: string[] = []
  const rejectProbe = (args: unknown[]) => {
    const pattern = args[0]
    if (typeof pattern === 'string' && pattern.includes('(?=/') && pattern.includes(segment)) {
      constructed.push(pattern)
      // Block the probe before it can backtrack, even if this regression returns.
      throw new Error('Literal route segments must not be executed as regular expressions')
    }
  }
  vi.stubGlobal(
    'RegExp',
    new Proxy(RegExp, {
      apply(target, thisArg, args) {
        rejectProbe(args)
        return Reflect.apply(target, thisArg, args)
      },
      construct(target, args, newTarget) {
        rejectProbe(args)
        return Reflect.construct(target, args, newTarget)
      },
    })
  )
  return constructed
}

function normalize(result: Result<string>) {
  return result[0].map(([handler, params]) => [
    handler,
    Object.fromEntries(
      Object.entries(params).map(([key, value]) => [
        key,
        result[1] ? result[1][value as number] : value,
      ])
    ),
  ])
}

describe('lookahead safety preparation cost', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(['.*', '.+'])(
    'preserves legacy literal %s suffixes without executing a regexp probe',
    (prefix) => {
      const segment = prefix + '(a+)+[' + 'a'.repeat(64) + 'b]Z'
      const path = '/cost/:id{[0-9]+}/' + segment
      const probes = guardLiteralLookahead(segment)
      const params = (0, eval)(
        serializeInitParams(buildInitParams({ paths: [path] }))
      ) as ConstructorParameters<typeof PreparedRegExpRouter<string>>
      const routers = [new RegExpRouter<string>(), new PreparedRegExpRouter<string>(...params)]
      for (const router of routers) {
        router.add('GET', path, 'endpoint')
        expect(normalize(router.match('GET', '/cost/42/' + segment))).toEqual([
          ['endpoint', { id: '42' }],
        ])
      }
      expect(probes).toEqual([])
    }
  )

  it.each(['.*', '.+'])(
    'serves a first Hono request for literal %s suffixes without executing a regexp probe',
    async (prefix) => {
      const segment = prefix + '(a+)+[' + 'a'.repeat(64) + 'b]Z'
      const path = '/cost/:id{[0-9]+}/' + segment
      const probes = guardLiteralLookahead(segment)
      const app = new Hono()
      app.get(path, (c) => c.json(c.req.param()))
      const response = await app.request(encodeURI('/cost/42/' + segment))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ id: '42' })
      expect(app.router.name).toBe('SmartRouter + RegExpRouter')
      expect(probes).toEqual([])
    }
  )

  it.each(['.*', '.+'])(
    'rejects an unproven literal %s suffix in new tables without executing it',
    (prefix) => {
      const segment = prefix + '(a+)+[' + 'a'.repeat(64) + 'b]Z'
      const path = '/cost/:id{[0-9]+}/' + segment
      const probes = guardLiteralLookahead(segment)
      for (const paths of [
        [path, ...disjoint],
        [...disjoint, path],
      ]) {
        expect(() => buildInitParams({ paths })).toThrowError(new UnsupportedPathError(path))
        const router = new RegExpRouter<string>()
        expect(() => {
          for (const path of paths) {
            router.add('GET', path, path)
          }
          router.match('GET', '/missing')
        }).toThrowError(new UnsupportedPathError(path))
      }
      expect(probes).toEqual([])
    }
  )

  it.each(['[a-z]*', String.raw`[\d]*`, '(a+)*'])(
    'keeps unproven %s syntax behind fallback while preserving legacy tables',
    (segment) => {
      const path = '/cost/:id{[0-9]+}/' + segment
      const probes = guardLiteralLookahead(segment)
      const params = (0, eval)(
        serializeInitParams(buildInitParams({ paths: [path] }))
      ) as ConstructorParameters<typeof PreparedRegExpRouter<string>>
      for (const router of [
        new RegExpRouter<string>(),
        new PreparedRegExpRouter<string>(...params),
      ]) {
        router.add('GET', path, 'endpoint')
        expect(normalize(router.match('GET', '/cost/42/' + segment))).toEqual([
          ['endpoint', { id: '42' }],
        ])
      }
      for (const paths of [
        [path, ...disjoint],
        [...disjoint, path],
      ]) {
        expect(() => buildInitParams({ paths })).toThrowError(new UnsupportedPathError(path))
        const router = new RegExpRouter<string>()
        expect(() => {
          for (const path of paths) {
            router.add('GET', path, path)
          }
          router.match('GET', '/missing')
        }).toThrowError(new UnsupportedPathError(path))
      }
      expect(probes).toEqual([])
    }
  )
})
