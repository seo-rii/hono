import { unstable_dev } from 'wrangler'
import type { Unstable_DevWorker } from 'wrangler'

describe('workerd disjoint routes with line terminators', () => {
  let worker: Unstable_DevWorker

  beforeAll(async () => {
    worker = await unstable_dev('./runtime-tests/workerd/disjoint-newlines.ts', {
      compatibilityDate: '2026-07-01',
      experimental: { disableExperimentalWarning: true },
    })
  })

  afterAll(async () => {
    await worker.stop()
  })

  describe.each(['default', 'prepared'])('%s router', (router) => {
    it.each(['%0A', '%0D', '%E2%80%A8', '%E2%80%A9'])(
      'keeps wildcard access denial for encoded %s',
      async (encoded) => {
        const response = await worker.fetch(`/missing${encoded}x`, {
          headers: { 'x-test-router': `${router}-auth` },
        })
        expect(response.status).toBe(403)
        expect(await response.text()).toBe('blocked')
      }
    )

    it.each(['%0A', '%0D', '%E2%80%A8', '%E2%80%A9'])(
      'preserves literal paths containing encoded %s',
      async (encoded) => {
        const headers = { 'x-test-router': `${router}-literal` }
        const response = await worker.fetch(`/a${encoded}b/42`, { headers })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ id: '42' })
        expect((await worker.fetch('/ab/42', { headers })).status).toBe(404)
      }
    )
  })
})
