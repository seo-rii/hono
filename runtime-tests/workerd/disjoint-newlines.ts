import { Hono } from '../../src/hono'
import { buildInitParams, PreparedRegExpRouter } from '../../src/router/reg-exp-router'
import type { H, RouterRoute } from '../../src/types'

const lineTerminators = ['\n', '\r', '\u2028', '\u2029']
const paths = [
  '*',
  '/group/:id{[0-9]+}',
  '/group/site/:id{[0-9]+}',
  ...lineTerminators.map((character) => `/a${character}b/:id{[0-9]+}`),
]

function createApp(prepared: boolean, auth: boolean): Hono {
  const app = new Hono({
    router: prepared
      ? new PreparedRegExpRouter<[H, RouterRoute]>(
          ...(buildInitParams({ paths }) as ConstructorParameters<
            typeof PreparedRegExpRouter<[H, RouterRoute]>
          >)
        )
      : undefined,
  })
  if (auth) {
    app.use('*', async (c) => c.text('blocked', 403))
    app.notFound((c) => c.text('public fallback', 200))
  }
  for (const path of paths.slice(1)) {
    app.get(path, (c) => c.json({ id: c.req.param('id') }))
  }
  return app
}

const apps = {
  'default-auth': createApp(false, true),
  'prepared-auth': createApp(true, true),
  'default-literal': createApp(false, false),
  'prepared-literal': createApp(true, false),
}

export default {
  fetch(request: Request) {
    const app = apps[request.headers.get('x-test-router') as keyof typeof apps]
    return app ? app.fetch(request) : new Response('Unknown test router', { status: 400 })
  },
}
