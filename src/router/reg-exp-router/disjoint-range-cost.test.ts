import { Hono } from '../../hono'
import type { Result, Router } from '../../router'
import { UnsupportedPathError } from '../../router'
import { TrieRouter } from '../trie-router'
import { buildInitParams, PreparedRegExpRouter, serializeInitParams } from './prepared-router'
import { RegExpRouter } from './router'

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
      Object.entries(params).map(([key, value]) => [
        key,
        result[1] ? result[1][value as number] : value,
      ])
    ),
  ])
}

function guardRangeComparisons() {
  const originalEvery = Array.prototype.every
  let comparisons = 0
  // Count interval comparisons instead of asserting machine-dependent timings.
  // Stop before a duplicate class can produce an unbounded cross product.
  return vi.spyOn(Array.prototype, 'every').mockImplementation(function (
    this: unknown[],
    callback,
    thisArg
  ) {
    const first = this[0]
    const isRangeArray =
      Array.isArray(first) &&
      first.length === 2 &&
      typeof first[0] === 'number' &&
      typeof first[1] === 'number'
    return originalEvery.call(this, (value, index, array) => {
      if (isRangeArray && ++comparisons > 8192) {
        throw new Error('Repeated class members must not multiply range comparisons')
      }
      return callback.call(thisArg, value, index, array)
    })
  })
}

describe.each(builders)('%s character-class normalization', (_name, build) => {
  afterEach(() => vi.restoreAllMocks())

  it.each([256, 1024])('bounds proof work for %s duplicate members', (count) => {
    const paths = ['a', 'b'].map((character) => `/g/:id{[${character.repeat(count)}]+}`)
    const guard = guardRangeComparisons()
    let router: Router<string>
    try {
      router = build(paths)
      router.match('GET', '/g/aaa')
    } finally {
      guard.mockRestore()
    }
    expect(normalize(router.match('GET', '/g/aaa'))).toEqual([[paths[0], { id: 'aaa' }]])
    expect(normalize(router.match('GET', '/g/bbb'))).toEqual([[paths[1], { id: 'bbb' }]])
    expect(normalize(router.match('GET', '/g/ab'))).toEqual([])
  })

  it.each(['[a-cb-dabc]+', '[-a-cabc]+', '[a-cabc-]+', '[a-aabc]+'])(
    'preserves duplicate and overlapping ranges in %s',
    (pattern) => {
      const paths = [`/g/:letters{${pattern}}`, '/g/:digits{[0-42-6]+}']
      for (const ordered of [paths, [...paths].reverse()]) {
        const reference = new TrieRouter<string>()
        ordered.forEach((path) => reference.add('GET', path, path))
        const router = build(ordered)
        const values = [
          ...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
          'aabbcc',
          '0123456',
          'abcdef',
          '--',
          'ab0',
        ]
        for (const value of values) {
          const request = '/g/' + value
          expect(normalize(router.match('GET', request)), JSON.stringify(value)).toEqual(
            normalize(reference.match('GET', request))
          )
        }
      }
    }
  )

  it('still rejects intersecting classes with repeated members', () => {
    const paths = [`/g/:first{[${'a'.repeat(256)}]+}`, `/g/:second{[${'b'.repeat(256)}a]+}`]
    for (const ordered of [paths, [...paths].reverse()]) {
      expect(() => build(ordered).match('GET', '/g/a')).toThrowError(UnsupportedPathError)
    }
  })
})

it('serves the first default Hono request with repeated disjoint classes', async () => {
  const app = new Hono()
  for (const character of ['a', 'b']) {
    app.get(`/g/:id{[${character.repeat(256)}]+}`, (c) => c.json(c.req.param()))
  }
  const guard = guardRangeComparisons()
  let response: Response
  try {
    response = await app.request('/g/bbb')
  } finally {
    guard.mockRestore()
  }
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ id: 'bbb' })
  expect(app.router.name).toBe('SmartRouter + RegExpRouter')
})
