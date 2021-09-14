// In order for the workers runtime to find the class that implements
// our Durable Object namespace, we must export it from the root module.
export { CounterTs } from './counter'
export { ChatRoom } from './ChatRoom'

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
  const room:string = params.get('room') || 'default';
  const chatRoomId = env.CHATROOM.idFromName(room);
  const chatRoom = await env.CHATROOM.get(chatRoomId);
  return await chatRoom.fetch(request);
}

interface Env {
  COUNTER: DurableObjectNamespace,
  CHATROOM: DurableObjectNamespace
}
