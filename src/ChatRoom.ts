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

import User, { getUser, setStorage } from './User'
import { Env } from './index'
import { parse } from 'cookie'

export class ChatRoom {
  storage: DurableObjectStorage;
  controller: ExpandedDurableObjectState;
  env: Env;
  sessions: {[key: string]: User[]} = {};
  name?:string;
  incrementValue: number = 1;
  counters:{[key: string]: number} = {};
  polls:{[key: string]:{[key: string]: {[key: string] : null}}} = {}
  ephemeralPolls:{[key: string]:{[key: string]: {[key: string] : null}}} = {}
  signingKey?: string;
  config: string = '';
  relays: {[key: string]:User[]} = {}

  constructor(controller: ExpandedDurableObjectState, env: Env) {
    this.storage = controller.storage;
    this.controller = controller;
    this.env = env;
    this.sessions = {}
    this.signingKey = env.ADMIN_SIGNING_KEY;
    setStorage(this.storage);
    controller.blockConcurrencyWhile(async () => {
      let stored:string | null | undefined = await this.storage.get("config");
      this.config = stored || '';
    })
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
      case '/users':
        return new Response(JSON.stringify({
          ts: (new Date()).getTime(),
          users: this.getAllSessions().map(u => {
            return {
              ...u.getPublicDetails(),
              lastCommunication: u.lastCommunicationTimestamp
            }
          })}))
      case '/websocket' :
        if (request.headers.get("Upgrade") != "websocket") {
          return new Response("expected websocket", {status: 400, headers: {'Set-Cookie': 'xxx=abc'}});
        }
        let pair = new WebSocketPair();
        let user:User|null = null;
        try {
          user = await this.handleSession(pair[1], request);
        } catch(e:any) {
          console.error('Something went wrong handling the session...', e.message, e.stack)
        }
        const headers = new Headers()
        if (user && user.id) {
          headers.set('Set-Cookie',`${this.controller.id}_session=${encodeURIComponent(user && user.id)}; SameSite=None; Secure`)
          headers.append('X-Session-Id', `${user && user.id}`);
        }
        headers.append('X-Socket-Server', `Pact Studio <workwithpact.com>`);


        return new Response(null, { status: 101, webSocket: pair[0], headers });
      default:
        return new Response("Oh, the sadness! This route does not exist.", {
          status: 404
        })
    }
  }
  removeUser(user: User) {
    if (!user || !user.id || !this.sessions[user.id]){
      return;
    }
    this.sessions[user.id] = this.sessions[user.id].filter(v => v !== user);
    if (!this.sessions[user.id].length) {
      delete this.sessions[user.id];
    }
  }
  addUser(user: User) {
    this.sessions[user.id] = this.sessions[user.id] || [];
    if (this.sessions[user.id].indexOf(user) === -1) {
      this.sessions[user.id].push(user);
    }
  }
  getAllSessions():User[] {
    const sessions: User[] = [];
    Object.keys(this.sessions).forEach(k => this.sessions[k].forEach(u => sessions.push(u)))
    return sessions;
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
    this.getAllSessions().forEach(session => {
      try {
        session.send(message, data)
      } catch(e) { }
    })
  }
  broadcastToSubscribers(subscription: string, message: SocketData | string, data:any = null) {
    const parts = `${subscription}`.split(':');
    const eventType = parts.shift();
    if (!eventType) {
      return
    }
    const eventId = parts.join(':') || 'all'
    this.getAllSessions().filter(session => session && session.properties && session.properties.subscriptions && session.properties.subscriptions[eventType] && (session.properties.subscriptions[eventType][eventId] || session.properties.subscriptions[eventType].all)).forEach(session => {
      try {
        session.send(message, data)
      } catch(e) { }
    })
  }
  async handleSession(client: WebSocket, request?: Request) {
    const url = new URL(request?.url || '');
    const searchParams = new URLSearchParams(url.search);
    const cookieName:string = `${this.controller.id}_session`
    const userId = searchParams.get('session') || parse(request?.headers.get('Cookie') || '')[cookieName] || null
    
    client.accept(); // Accept the websocket connection, telling CF we will be handling this internally and won't be passing it off

    const suffix = ++this.incrementValue; // Increment our suffix

    const user:User = await getUser({ // Getting our user; If the id exists, it will retrieve it from memory if available. Otherwise, a new user will be created.
      suffix,
      id: userId,
      socket: client,
      connectionDetails: request?.cf,
    })
    this.addUser(user)

    const config:SocketData = {
      type: "config",
      data: this.config
    }
    user.send(config);

    const profile:SocketData = {
      type: 'profile',
      data: user.getPrivateDetails()
    }
    user.send(profile);

    user.on('login', (properties) => {
      user.setProperties(properties);
      const profile:SocketData = {
        type: 'profile',
        data: user.getPrivateDetails()
      }
      user.send(profile);
    })

    user.on('profile', () => {
      const profile:SocketData = {
        type: 'profile',
        data: user.getPrivateDetails()
      }
      user.send(profile);
    })

    user.on('authenticate', async (data) => {
      const {
        key,
        ts
      } = data
      const now = new Date()
      const utcNow = new Date( now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds() );
      const diff = Math.abs((ts*1) - utcNow.getTime())
      if (diff > 60*5*1000) {
        user.send('error', "Wrong timestamp. Received " + ts + " but now is " + now.getTime() + " Diff is " + diff)
        return; // Outdated.
      }
      const unencodedKey = new TextEncoder().encode(`${this.name}${ts}${this.signingKey}`)
      const digest = await crypto.subtle.digest(
        {
          name: "SHA-256",
        },
        unencodedKey
      )
      const hex = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').toLowerCase();
      if (`${key.toLowerCase()}` === hex) {
        user.setRole('admin');
        user.trigger('profile')
      }
    })

    user.on('*', (data, type) => {
      (this.relays[type] || []).forEach(u => u.send(`relay:${type}`, {
        type,
        data,
        user: user.getPrivateDetails()
      }));
    })

    user.on('relay', (type) => {
      if (user.role !== 'admin') {
        return;
      }
      this.relays[type] = this.relays[type] || []
      if (this.relays[type].indexOf(user) === -1) {
        this.relays[type].push(user)
      }
    })

    user.on('deleteRelay', type => {
      Object.keys(this.relays).filter(k => !type || k === type).forEach(k => this.relays[k] = this.relays[k].filter(u => u !== user))
      if(!type) {
        this.relays = {};
      }
      if (this.relays[type]) {
        delete this.relays[type];
      }
    })

    user.on('config', (config) => {
      if (user.role !== 'admin') {
        return;
      }
      this.config = `${config}`
      this.storage.put('config', `${config}`);
      this.broadcast({
        type: "config",
        data: this.config
      })
    })

    user.on('broadcast', (data) => {
      if (user.role !== 'admin') {
        return;
      }
      const subscription = data && data.to
      if (subscription) {
        this.broadcastToSubscribers(data.to, {
          type: data.type,
          data: data.data
        })
      } else {
        this.broadcast({
          type: data.type,
          data: data.data
        })
      }
    })

    user.on('subscribe', (channel) => {
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
          user.send(pollResults)
        })
      } else if(eventType === 'ephemeralPoll') {
        Object.keys(this.ephemeralPolls).filter(id => id === eventId || eventId === 'all').forEach(id => {
          const pollResults:SocketData = this.generatePollSocketData(id, 'ephemeralPoll');
          user.send(pollResults)
        })
      } else if(eventType === 'counter') {
        Object.keys(this.counters).filter(id => id === eventId || eventId === 'all').forEach(id => {
          const pollResults:SocketData = this.generatePollSocketData(id, 'ephemeralPoll');
          user.send({
            type: 'counter',
            data: {
              id,
              value: this.counters[id] || 0
            }
          })
        })
      }
    })

    user.on('unsubscribe', (channel) => {
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
          if (Object.keys(pollsObject[id][ans]).length === 0) {
            delete pollsObject[id][ans];
          }
        }
      })
      pollsObject[id][answer] = pollsObject[id][answer] || {};
      pollsObject[id][answer][user.id] = null;

      this.broadcastToSubscribers(`${type}:${id}`, this.generatePollSocketData(id, type))
    }
    user.on('poll', onPoll)
    user.on('ephemeralPoll', onPoll)

    user.on('counter', (counter) => {
      const id = counter && counter.id || 'default';
      const value = counter ? counter.value * 1 : 1
      if (isNaN(value)) {
        return;
      }
      this.counters[id] = this.counters[id] || 0;
      this.counters[id] += value
      this.broadcastToSubscribers(`counter:${id}`, {
        type: 'counter',
        data: {
          id,
          value: this.counters[id]
        }
      });
    })

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
            if (Object.keys(this.ephemeralPolls[pollId][ans]).length === 0) {
              delete this.ephemeralPolls[pollId][ans];
            }
            polls.push(pollId)
            return true;
          }
        })
      })
      polls.forEach(id => {
        const pollResults:SocketData = this.generatePollSocketData(id, 'ephemeralPoll');
        this.broadcastToSubscribers(`ephemeralPoll:${id}`, pollResults)

      })
      this.removeUser(user);
      /* Clean up relays*/
      Object.keys(this.relays).forEach(k => {
        this.relays[k] = this.relays[k].filter(u => u !== user)
      })
      client.close();
    })
    return user;
  }



  async getRoomDetails():Promise<RoomDetails> {
    const details:RoomDetails = {
      id: `${this.controller.id}`,
      name: this.name || '',
      count: this.getAllSessions().length,
      uniqueCount: Object.keys(this.sessions).length,
      increment: this.incrementValue,
      pollCount: Object.keys(this.polls).length,
      config: this.config,
      ephemeralPollCount: Object.keys(this.ephemeralPolls).length
    }
    return details;
  }
}

export interface RoomDetails {
  id: string;
  name: string;
  count: number;
  uniqueCount: number;
  config: any;
  increment: number;
  pollCount: number;
  ephemeralPollCount: number;
}

export type SocketDataTypes = 'config' | 'chat' | 'poll' | 'ephemeralPoll' | 'login' | 'join' | 'leave' | 'broadcast' | 'close' | 'subscribe' | 'unsubscribe' | 'profile' | 'ping' | 'counter' | 'error' | 'relay' | 'deleteRelay' | '*';

export interface SocketData {
  type: SocketDataTypes;
  data?: any
}

export interface ExpandedDurableObjectState extends DurableObjectState {
  blockConcurrencyWhile(promise: () => Promise<void>): void;
}