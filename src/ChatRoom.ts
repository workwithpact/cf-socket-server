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
  polls:{[key: string]:{[key: string]: {[key: string] : null}}} = {}
  ephemeralPolls:{[key: string]:{[key: string]: {[key: string] : null}}} = {}

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
  broadcastToSubscribers(subscription: string, message: SocketData | string, data:any = null) {
    const parts = `${subscription}`.split(':');
    const eventType = parts.shift();
    if (!eventType) {
      return
    }
    const eventId = parts.join(':') || 'all'
    this.sessions.filter(session => session.properties && session.properties.subscriptions && session.properties.subscriptions[eventType] && (session.properties.subscriptions[eventType][eventId] || session.properties.subscriptions[eventType].all)).forEach(session => session.send(message, data))
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

    user.on('login', (properties) => {
      user.properties = properties || {};
    })

    user.on('subscribe', (channel) => {
      user.properties = user.properties || {}
      user.properties.subscriptions = user.properties.subscriptions || {}
      const parts = `${channel}`.split(':');
      const eventType = parts.shift();
      if (!eventType) {
        return
      }
      const eventId = parts.join(':') || 'all'
      user.properties.subscriptions[eventType] = user.properties.subscriptions[eventType] || {}
      user.properties.subscriptions[eventType][eventId] = true
    })

    user.on('unsubscribe', (channel) => {
      user.properties = user.properties || {}
      user.properties.subscriptions = user.properties.subscriptions || {}
      const parts = `${channel}`.split(':');
      const eventType = parts.shift();
      if (!eventType) {
        return
      }
      const eventId = parts.join(':') || 'all'
      if (user.properties.subscriptions[eventType] && eventId === 'all') {
        delete user.properties.subscriptions[eventType];
      }
      else if(user.properties.subscriptions[eventType] && user.properties.subscriptions[eventType][eventId]) {
        delete user.properties.subscriptions[eventType][eventId];
      }
    })

    // Handling both long-lasting and ephemeral polls
    const onPoll = (poll: any, type: SocketDataTypes) => {
      const pollsObject = type === 'poll' ? this.polls : this.ephemeralPolls;
      const {
        id,
        answer
      } = poll
      pollsObject[id] = pollsObject[id] || {}
      // Delete previous answers from the same client
      Object.keys(pollsObject[id]).forEach(ans => {
        if (typeof pollsObject[id][ans][user.id] !== 'undefined') {
          delete pollsObject[id][ans][user.id];
        }
      })
      pollsObject[id][answer] = pollsObject[id][answer] || {}
      pollsObject[id][answer][user.id] = null;
      const pollResults:SocketData = {
        type,
        data: {
          id,
          stats: {}
        }
      }
      Object.keys(pollsObject[id]).forEach(ans => pollResults.data.stats[ans] = Object.keys(pollsObject[id][ans]).length)
      this.broadcastToSubscribers(`${type}:${id}`, pollResults)
    }
    user.on('poll', onPoll)

    /* Chat */

    user.on('chat', text => {
      const chatMessage:SocketData = {
        type: 'chat',
        data: {
          message: text,
          user: user.getPublicDetails()
        }
      }
      this.broadcastToSubscribers('chat', chatMessage)
    })
    user.on('close', () => {
      /* Clear out ephemeral poll answers */
      const polls:string[] = []
      Object.keys(this.ephemeralPolls).forEach(pollId => {
        Object.keys(this.ephemeralPolls[pollId]).find(ans => {
          if (typeof this.ephemeralPolls[pollId][ans][user.id] !== 'undefined') {
            delete this.ephemeralPolls[pollId][ans][user.id];
            polls.push(pollId)
            return true;
          }
        })
      })
      polls.forEach(id => {
        const pollResults:SocketData = {
          type: 'ephemeralPoll',
          data: {
            id,
            stats: {}
          }
        }
        Object.keys(this.ephemeralPolls[id]).forEach(ans => pollResults.data.stats[ans] = Object.keys(this.ephemeralPolls[id][ans]).length)
        this.broadcastToSubscribers(`ephemeralPoll:${id}`, pollResults)

      })
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

export type SocketDataTypes = 'config' | 'chat' | 'poll' | 'ephemeralPoll' | 'login' | 'join' | 'leave' | 'broadcast' | 'close' | 'subscribe' | 'unsubscribe';

export interface SocketData {
  type: SocketDataTypes;
  data?: any
}

export interface Env {}

export interface ExpandedDurableObjectState extends DurableObjectState {
  blockConcurrencyWhile(promise: () => Promise<void>): void;
}