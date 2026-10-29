import { Hono } from '../../hono'
import { UnsupportedPathError } from '../../router'
import { buildInitParams } from './prepared-router'
import { RegExpRouter } from './router'
import { Trie } from './trie'

const disjoint = ['/new/:id{[0-9]+}', '/new/site/:id{[0-9]+}']

afterEach(() => vi.restoreAllMocks())

describe('disjoint matcher compilation capacity', () => {
  it.each(['GET', 'POST'])(
    'rejects capacity errors as unsupported even when the failing trie is %s',
    (method) => {
      const router = new RegExpRouter<string>()
      for (const path of disjoint) {
        router.add('GET', path, path)
      }
      router.add(method, '/capacity/:value', 'capacity')
      const original = Trie.prototype.buildRegExp
      vi.spyOn(Trie.prototype, 'buildRegExp').mockImplementation(function (this: Trie) {
        if (Object.hasOwn(this.paths, '/capacity/:value')) {
          throw new RangeError('matcher capacity exceeded')
        }
        return original.call(this)
      })
      expect(() => router.match('GET', '/new/42')).toThrowError(UnsupportedPathError)
    }
  )

  it('lets Prepared compilation report an unsupported table on capacity failure', () => {
    vi.spyOn(Trie.prototype, 'buildRegExp').mockImplementation(() => {
      throw new RangeError('matcher capacity exceeded')
    })
    expect(() => buildInitParams({ paths: disjoint })).toThrowError(UnsupportedPathError)
  })

  it('preserves the original capacity error for tables without disjoint branches', () => {
    const error = new RangeError('legacy matcher capacity exceeded')
    const router = new RegExpRouter<string>()
    router.add('GET', '/legacy/:id', 'legacy')
    vi.spyOn(Trie.prototype, 'buildRegExp').mockImplementation(() => {
      throw error
    })
    expect(() => router.match('GET', '/legacy/42')).toThrow(error)
    expect(() => buildInitParams({ paths: ['/legacy/:id'] })).toThrow(error)
  })

  it.each([new Error('compiler failure'), new TypeError('compiler type failure')])(
    'rethrows unrelated compiler errors: %s',
    (error) => {
      const router = new RegExpRouter<string>()
      for (const path of disjoint) {
        router.add('GET', path, path)
      }
      vi.spyOn(Trie.prototype, 'buildRegExp').mockImplementation(() => {
        throw error
      })
      expect(() => router.match('GET', '/new/42')).toThrow(error)
      expect(() => buildInitParams({ paths: disjoint })).toThrow(error)
    }
  )
})

describe('Hono fallback for deep registered paths', () => {
  it.each([
    ['GET', false, false],
    ['GET', false, true],
    ['GET', true, false],
    ['GET', true, true],
    ['POST', false, false],
    ['POST', false, true],
    ['POST', true, false],
    ['POST', true, true],
  ] as const)(
    'serves short requests with method=%s, dynamic=%s, longFirst=%s',
    async (method, dynamic, longFirst) => {
      const app = new Hono()
      const prefix = '/long/' + 'a'.repeat(8192)
      const path = prefix + (dynamic ? '/:tail' : '')
      const addLong = () => {
        app.on(method, path, (c) => c.json({ handler: 'long', params: c.req.param() }))
      }
      if (longFirst) {
        addLong()
      }
      for (const route of disjoint) {
        app.get(route, (c) => c.json({ handler: 'number', id: c.req.param('id') }))
      }
      if (!longFirst) {
        addLong()
      }
      const response = await app.request('/new/42')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ handler: 'number', id: '42' })
      const longResponse = await app.request(prefix + (dynamic ? '/value' : ''), { method })
      expect(longResponse.status).toBe(200)
      expect(await longResponse.json()).toEqual({
        handler: 'long',
        params: dynamic ? { tail: 'value' } : {},
      })
    }
  )
})
