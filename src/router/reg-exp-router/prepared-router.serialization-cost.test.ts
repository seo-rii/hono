import { buildInitParams, PreparedRegExpRouter, serializeInitParams } from './prepared-router'

type InitParams = ConstructorParameters<typeof PreparedRegExpRouter>

function materialize(params: InitParams): InitParams {
  const source = serializeInitParams(params)
  const utf8 = new TextDecoder().decode(new TextEncoder().encode(source))
  return (0, eval)(utf8) as InitParams
}

function guardBackslashScan() {
  const originalReplace = String.prototype.replace
  return vi.spyOn(String.prototype, 'replace').mockImplementation(function (
    this: string,
    searchValue,
    replaceValue
  ) {
    if (
      this.includes('\\'.repeat(512)) &&
      searchValue instanceof RegExp &&
      searchValue.source.includes(String.raw`\\*`)
    ) {
      // Reject the scan before it can backtrack on engines without V8's optimization.
      throw new Error('Surrogate scans must not retry an unbounded backslash prefix')
    }
    return Reflect.apply(originalReplace, this, [searchValue, replaceValue]) as string
  })
}

describe('prepared initializer surrogate scan cost', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['', 'tail\uD800'])(
    'serializes a long backslash run followed by %j without retrying prefixes',
    (suffix) => {
      const count = 512
      const route = '/g/:id{' + '\\\\'.repeat(count) + suffix + '}'
      const params = buildInitParams({ paths: [route] })
      const guard = guardBackslashScan()
      let restored: InitParams
      try {
        restored = materialize(params)
      } finally {
        guard.mockRestore()
      }
      const router = new PreparedRegExpRouter(...restored)
      router.add('GET', route, 'endpoint')
      const value = '\\'.repeat(count) + suffix
      const [handlers, captures] = router.match('GET', '/g/' + value)
      expect(handlers).toHaveLength(1)
      expect(handlers[0][0]).toBe('endpoint')
      expect(captures![handlers[0][1].id as number]).toBe(value)
      expect(router.match('GET', '/g/' + value + 'extra')[0]).toEqual([])
    }
  )

  it.each([0, 1, 2, 3])(
    'preserves a long run with %i extra backslashes before a lone surrogate',
    (extra) => {
      const count = 1024 + extra
      const params = buildInitParams({ paths: ['/g/:id'] })
      const regexp = new RegExp('^' + '\\'.repeat(count) + '\uD800' + '$')
      params[0].ALL![0] = regexp
      const copy = materialize(params)[0].ALL![0]
      const value = '\\'.repeat(Math.floor(count / 2)) + '\uD800'
      expect(regexp.test(value)).toBe(true)
      for (const candidate of [
        value,
        value + 'x',
        value.slice(1),
        '\\'.repeat(Math.floor(count / 2)) + 'ud800',
      ]) {
        expect(copy.test(candidate)).toBe(regexp.test(candidate))
      }
    }
  )

  it.each(['', 'u', 'v'])(
    'preserves surrogate atom boundaries after distant runs with %s',
    (flags) => {
      const run = '\\\\'.repeat(512)
      for (const tail of ['\uD800' + '\\uDC00', '\\uD800' + '\uDC00', '\uD83D\uDE00']) {
        const params = buildInitParams({ paths: ['/g/:id'] })
        const regexp = new RegExp('^' + run + 'tail' + tail + '$', flags)
        params[0].ALL![0] = regexp
        const copy = materialize(params)[0].ALL![0]
        expect(copy.flags).toBe(flags)
        for (const suffix of [
          '\uD800',
          '\uDC00',
          '\uD800\uDC00',
          '\uD83D\uDE00',
          '\uFFFD',
          'ud800',
        ]) {
          const value = '\\'.repeat(512) + 'tail' + suffix
          expect(copy.test(value)).toBe(regexp.test(value))
        }
      }
    }
  )
})
