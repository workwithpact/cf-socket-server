import { uuid } from '@cfworker/uuid';
import { SocketData, SocketDataTypes } from './ChatRoom';

export default class User {
  id: string;
  suffix: number;
  name?: string;
  properties: {[key: string]: any}
  connectionDetails: {[key: string]: any}
  socket?: WebSocket | null;
  connected:boolean = false;
  listeners: {[key: string]: ((data: any, type: SocketDataTypes) => void)[]} = {};
  pingInterval?: number;
  lastCommunicationTimestamp?:number;
  role: 'user' | 'admin' = 'user'

  constructor({id=null, suffix=0, name='', properties={}, connectionDetails={}, socket = undefined} : UserData) {
    this.id = id || uuid();
    this.suffix = suffix || 0
    this.name = name || ''
    this.properties = properties || {}
    this.connectionDetails = connectionDetails || {}
    this.setSocket(socket)

    this.send = this.send.bind(this)
    this.off = this.off.bind(this)
    this.on = this.on.bind(this)
    this.getPublicDetails = this.getPublicDetails.bind(this)
    this.getPublicProperties = this.getPublicProperties.bind(this)
    this.processIncomingMessage = this.processIncomingMessage.bind(this)
    this.setRole = this.setRole.bind(this)
    this.trigger = this.trigger.bind(this)
  }

  setRole(newRole:'user' | 'admin') {
    this.role = newRole;
  }

  setSocket(socket?: WebSocket | null) {
    this.socket = socket;
    this.connected = !!socket

    socket?.addEventListener('message', (message) => {
      try {
        const parsedMessage = JSON.parse(message.data) as SocketData
        this.processIncomingMessage(parsedMessage);
        this.lastCommunicationTimestamp = (new Date()).getTime()
      } catch(e:any) {
        console.error('Something went wrong processing callbacks', e.message, e.stack)
      }
    })
    socket?.addEventListener('close', () => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
      }
      const type = 'close';
      this.connected = false;
      const callbacks = this.listeners[type] || [];
      callbacks.forEach(cb => {
        try {
          cb(null, type)
        } catch(e) {
          console.error('Could not call callback for type', type)
        }
      });
    })
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    this.pingInterval = setInterval(() => {
      const now:number = (new Date()).getTime()
      const timeout = 25 * 2 * 1000
      this.send({
        type: "ping",
        data: now
      })
      if (this.lastCommunicationTimestamp && (now - this.lastCommunicationTimestamp) >= timeout) {
        this.close();
      }
    }, 25000)
  }

  processIncomingMessage(message: SocketData) {
    const type = message.type;
    if (type === 'close') {
      try {
        this.socket?.close();
      } catch(e) {}
      this.connected = false;
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
      }
    }
    try {
      const callbacks = this.listeners[type] || [];
      callbacks.forEach(cb => cb(message.data, type));
    } catch(e:any) {
      console.error('Something went wrong processing callbacks', e.message, e.stack)
    }
  }

  on(type:string, cb: (data: any, type: SocketDataTypes) => void) {
    this.listeners[type] = this.listeners[type] || []
    this.listeners[type].push(cb);
  }

  off(type:string, cb: (data: any, type: SocketDataTypes) => void) {
    this.listeners[type] = (this.listeners[type] || []).filter(v => v !== cb)
  }

  trigger(message: SocketData | string, data:any = null) {
    const finalMessage = typeof message === 'string' ? {
      type: message,
      data
    } as SocketData : message

    this.processIncomingMessage(finalMessage)
  }

  getPublicDetails():UserData {
    return {
      name: this.name,
      suffix: this.suffix,
      properties: this.getPublicProperties()
    }
  }

  close() {
    this.trigger('close');
  }

  getPublicProperties(): {[key: string]: any} {
    const publicProperties:{[key: string]: any} = {}
    Object.keys(this.properties || {}).filter(v => v.indexOf('_') !== 0 && v !== 'subscriptions').forEach(k => publicProperties[k] = this.properties[k])
    return publicProperties;
  }

  getPrivateDetails():UserData {
    return {
      name: this.name,
      suffix: this.suffix,
      properties: this.properties,
      id: this.id,
      connectionDetails: this.connectionDetails,
      role: this.role
    }
  }

  send(message: SocketData | string, data:any = null) {
    try {
      const finalMessage = typeof message === 'string' ? {
        data,
        type: message
      } : message;
      this.socket?.send(JSON.stringify(finalMessage))
      this.lastCommunicationTimestamp = (new Date()).getTime()
    } catch(e) {
      this.connected = false;
      try{
        this.socket?.close();
      } catch (e) {}
      this.trigger('close');
      console.error('Could not send to socket; Closed it as a result.');
    }
  }
}

export interface UserData {
  id?: string | null;
  suffix?: number | null;
  name?: string | null;
  properties?: {[key: string]: any} | null;
  connectionDetails?: {[key: string]: any} | null;
  socket?: WebSocket | null;
  role?: 'user' | 'admin'
}