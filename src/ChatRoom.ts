declare global {
  interface WebSocket {
    accept(): void;
  }

  class WebSocketPair {
    0: WebSocket;
    1: WebSocket;
  }

  interface ResponseInit {
    webSocket?: WebSocket;
  }
}

import User from './User'

export class ChatRoom {
  storage: DurableObjectStorage;
  controller: ExpandedDurableObjectState;
  env: Env;
  sessions: User[];
  name?:string;
  incrementValue: number = 1;

  constructor(controller: ExpandedDurableObjectState, env: Env) {
    this.storage = controller.storage;
    this.controller = controller;
    this.env = env;
    this.sessions = []
  }

  // The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
  // can only be sent from other Worker code, such as the code above; these requests don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  async fetch(request: Request) {
    const url:URL = new URL(request.url);
    const params:URLSearchParams = new URLSearchParams(url.search);
    this.name = params.get('room') || 'default';
    switch(url.pathname) {
      case '/':
        return new Response(JSON.stringify(await this.getRoomDetails()))
      case '/websocket' :
        if (request.headers.get("Upgrade") != "websocket") {
          return new Response("expected websocket", {status: 400});
        }
        let ip = request.headers.get("CF-Connecting-IP");
        let pair = new WebSocketPair();
        await this.handleSession(pair[1], ip || undefined);
        return new Response(null, { status: 101, webSocket: pair[0] });
      default:
        return new Response("Oh, the sadness! This route does not exist.", {
          status: 404
        })
    }
  }
  broadcast(message: SocketData | string, data:any = null) {
    this.sessions.forEach(session => session.send(message, data))
  }
  async handleSession(client: WebSocket, ip?: string) {
    client.accept();
    const suffix = ++this.incrementValue;
    const user:User = new User({
      suffix,
      socket: client,
    })
    this.sessions.push(user);

    const config:SocketData = {
      type: "config",
      data: {}
    }

    try {
      config.data = JSON.parse((await this.getRoomDetails()).config)
    } catch(e) {
      console.error('Something went terribly, terribly wrong.', e)
    }
    user.send(config);
    user.on('chat', text => {
      const chatMessage:SocketData = {
        type: 'chat',
        data: {
          message: text,
          user: user.getPublicDetails()
        }
      }
      this.broadcast(chatMessage)
    })
    user.on('close', () => {
      this.sessions = this.sessions.filter((session) => session !== user);
    })
  }

  async getRoomDetails():Promise<RoomDetails> {
    const details:RoomDetails = {
      id: `${this.controller.id}`,
      name: this.name || '',
      config: await this.storage.get('config') || '',
      count: this.sessions.length
    }
    return details;
  }
}

export interface RoomDetails {
  id: string;
  name: string;
  count: number;
  config: any;
}

export interface SocketData {
  type: 'config' | 'chat' | 'poll' | 'login' | 'join' | 'leave' | 'broadcast' | 'close';
  data?: any
}

export interface Env {}

export interface ExpandedDurableObjectState extends DurableObjectState {
  blockConcurrencyWhile(promise: () => Promise<void>): void;
}