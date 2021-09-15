import { uuid } from '@cfworker/uuid';
import { SocketData, SocketDataTypes } from './ChatRoom';

export default class User {
  id: string;
  suffix: number;
  name?: string;
  properties: {[key: string]: any}
  socket?: WebSocket | null;
  connected:boolean = false;
  listeners: {[key: string]: ((data: any, type: SocketDataTypes) => void)[]} = {}

  constructor({id=null, suffix=0, name='', properties={}, socket = undefined} : UserData) {
    this.id = id || uuid();
    this.suffix = suffix || 0
    this.name = name || ''
    this.properties = properties || {}
    this.setSocket(socket)

    this.send = this.send.bind(this)
    this.off = this.off.bind(this)
    this.on = this.on.bind(this)
    this.getPublicDetails = this.getPublicDetails.bind(this)
    this.getPublicProperties = this.getPublicProperties.bind(this)
  }

  setSocket(socket?: WebSocket | null) {
    this.socket = socket;
    this.connected = !!socket

    socket?.addEventListener('message', (message) => {
      try {
        const parsedMessage = JSON.parse(message.data) as SocketData
        const type = parsedMessage.type;

        if (type === 'close') {
          socket.close();
          return;
        }
        const callbacks = this.listeners[type] || [];
        callbacks.forEach(cb => cb(parsedMessage.data, type));
      } catch(e:any) {
        socket.send('Something went wrong' + e.message + e.stack)
      }
    })
    socket?.addEventListener('close', () => {
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
  }

  on(type:string, cb: (data: any, type: SocketDataTypes) => void) {
    this.listeners[type] = this.listeners[type] || []
    this.listeners[type].push(cb);
  }

  off(type:string, cb: (data: any, type: SocketDataTypes) => void) {
    this.listeners[type] = (this.listeners[type] || []).filter(v => v !== cb)
  }

  getPublicDetails():UserData {
    return {
      name: this.name,
      suffix: this.suffix,
      properties: this.getPublicProperties()
    }
  }

  getPublicProperties(): {[key: string]: any} {
    const publicProperties:{[key: string]: any} = {}
    Object.keys(this.properties || {}).filter(v => v.indexOf('_') !== 0).forEach(k => publicProperties[k] = this.properties[k])
    return publicProperties;
  }

  send(message: SocketData | string, data:any = null) {
    try {
      const finalMessage = typeof message === 'string' ? {
        data,
        type: message
      } : message;
      this.socket?.send(JSON.stringify(finalMessage))
    } catch(e) {
      this.connected = false;
      try{
        this.socket?.close();
      } catch (e) {}
      console.error('Could not send to socket; Closed it as a result.');
    }
  }
}

export interface UserData {
  id?: string | null;
  suffix?: number | null;
  name?: string | null;
  properties?: {[key: string]: any} | null;
  socket?: WebSocket | null;
}