// In order for the workers runtime to find the class that implements
// our Durable Object namespace, we must export it from the root module.
export { ChatRoom } from './ChatRoom'

import chatHtml from './demo/chat.html'
import pollHtml from './demo/poll.html'
import ephemeralHtml from './demo/ephemeral.html'
import livemapDemo from './demo/livemap.html'
import indexHtml from './demo/index.html'

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handleRequest(request, env)
    } catch (e: any) {
      return new Response(e.message)
    }
  },
}

async function handleRequest(request: Request, env: Env) {
  const url:URL = new URL(request.url);
  const params:URLSearchParams = new URLSearchParams(url.search);
  switch(url.pathname) {
    case '/':
      return new Response(indexHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      })
    case '/livemap':
      return new Response(livemapDemo, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      })
    case '/chat':
      return new Response(chatHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      })
    case '/poll':
      return new Response(pollHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      })
    case '/ephemeral':
      return new Response(ephemeralHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        }
      })
  }
  // Disabled due to high costs
  // return new Response('This service has been disabled temporarily.')
  const room:string = params.get('room') || 'default';
  const chatRoomId = env.CHATROOM.idFromName(room);
  const chatRoom = await env.CHATROOM.get(chatRoomId);
  return await chatRoom.fetch(request);
}

export interface Env {
  COUNTER: DurableObjectNamespace,
  CHATROOM: DurableObjectNamespace,
  ADMIN_SIGNING_KEY: string
}
