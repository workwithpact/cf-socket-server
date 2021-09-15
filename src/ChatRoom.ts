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
      case '/details':
        return new Response(JSON.stringify(await this.getRoomDetails()))
      case '/websocket' :
        if (request.headers.get("Upgrade") != "websocket") {
          return new Response("expected websocket", {status: 400});
        }
        let pair = new WebSocketPair();
        await this.handleSession(pair[1], request);
        return new Response(null, { status: 101, webSocket: pair[0] });
      default:
        return new Response("Oh, the sadness! This route does not exist.", {
          status: 404
        })
    }
  }
  generatePollSocketData(id:string, type:SocketDataTypes = 'poll'):SocketData {
    const pollObject = type === 'poll' ? this.polls : this.ephemeralPolls;
    const pollResults:SocketData = {
      type,
      data: {
        id,
        stats: {}
      }
    }
    Object.keys(pollObject[id] || {}).forEach(ans => pollResults.data.stats[ans] = Object.keys(pollObject[id][ans]).length)
    return pollResults
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
  async handleSession(client: WebSocket, request?: Request) {
    client.accept();
    const suffix = ++this.incrementValue;
    const user:User = new User({
      suffix,
      socket: client,
      connectionDetails: request?.cf
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
    const profile:SocketData = {
      type: 'profile',
      data: user.getPrivateDetails()
    }
    user.send(profile);
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

      /* Upon subscription to a poll or ephemeralPoll, we send out stats for that poll */
      if (eventType === 'poll') {
        Object.keys(this.polls).filter(id => id === eventId || eventId === 'all').forEach(id => {
          const pollResults:SocketData = this.generatePollSocketData(id, 'poll');
          this.broadcastToSubscribers(`poll:${id}`, pollResults)
        })
      } else if(eventType === 'ephemeralPoll') {
        Object.keys(this.ephemeralPolls).filter(id => id === eventId || eventId === 'all').forEach(id => {
          const pollResults:SocketData = this.generatePollSocketData(id, 'ephemeralPoll');
          this.broadcastToSubscribers(`ephemeralPoll:${id}`, pollResults)
        })
      }
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
      pollsObject[id][answer] = pollsObject[id][answer] || {};
      pollsObject[id][answer][user.id] = null;

      this.broadcastToSubscribers(`${type}:${id}`, this.generatePollSocketData(id, type))
    }
    user.on('poll', onPoll)
    user.on('ephemeralPoll', onPoll)

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
        const pollResults:SocketData = this.generatePollSocketData(id, 'ephemeralPoll');
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
      count: this.sessions.length,
      increment: this.incrementValue,
      pollCount: Object.keys(this.polls).length,
      ephemeralPollCount: Object.keys(this.ephemeralPolls).length
    }
    return details;
  }
}

export interface RoomDetails {
  id: string;
  name: string;
  count: number;
  config: any;
  increment: number;
  pollCount: number;
  ephemeralPollCount: number;
}

export type SocketDataTypes = 'config' | 'chat' | 'poll' | 'ephemeralPoll' | 'login' | 'join' | 'leave' | 'broadcast' | 'close' | 'subscribe' | 'unsubscribe' | 'profile';

export interface SocketData {
  type: SocketDataTypes;
  data?: any
}

export interface Env {}

export interface ExpandedDurableObjectState extends DurableObjectState {
  blockConcurrencyWhile(promise: () => Promise<void>): void;
}