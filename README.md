# Pact's Socket Server


## Note: You must use [wrangler](https://developers.cloudflare.com/workers/cli-wrangler/install-update) 1.17 or newer to use this repository.

## Please read the [Durable Object documentation](https://developers.cloudflare.com/workers/learning/using-durable-objects) before diving in.

## What is this?
This nifty little project is a swiss army knife for realtime backend projects. It is scoped to rooms, and encompasses multiple useful features.

## How do I use this?
You don't have to install or deploy this to make use of it, assuming you're working for/with Pact :).

Simply create a new WebSocket connection to `wss://sockets.workwithpact.com/websocket?room=CHANGEME`, where `CHANGEME` is the name of your room. The room's name can be anything.

## What features are supported?

### Setting profile properties: `login`
Sending a `login` payload allows you to attach properties to your user session. Properties that start with a `_` are considered private; They are not sent out to anyone other than yourself, through a `profile` response.
After sending a `login` payload, you can expect a `profile` response from the server.
```json
{
  "type": "login",
  "data": {...} 
}
```

### Getting your profile: `profile`
If you send a `profile` request:
```json
{
  "type": "profile"
}
```

The server will send back a `profile` response containing your user profile, ex:
```json
{
  "type": "profile",
  "data": {
    "suffix":4534,
    "properties":{},
    "id":"c02246a4-799c-431e-b796-1b102c04595d",
    "connectionDetails":{ ... }
  }
}
```
The `connectionDetails` key is the contents of `request.cf`. It can be used for IP-based geolocation.

### Subscribing to events: `subscribe`
You may subscribe to events.
Right now, the supported subscription events are `poll`, `ephemeralPoll`, `chat` and `counter`.

When subscribing, you may add a specific identifier to subscribe to. For example, maybe you don't need to receive all poll updates and only care about a specific poll.
You can do so by adding `:id_here` after the event name, ex: `poll:id_here`.

Subscribe to a specific counter:
```json
{
  "type": "subscribe",
  "data": "counter:order_confirmation_subtotal"
}
```

Subscribe to chat:
```json
{
  "type": "subscribe",
  "data": "chat"
}
```

Subscribe to all polls:
```json
{
  "type": "subscribe",
  "data": "poll"
}
```

### Unsubscribing from events: `unsubscribe`
Similarly to subscriptions, you may unsubscribe from events.
It follows the same logic. If you send an unsubscribe payload without an id, all events of the type are unsubscribed.

Unsubscribe from a specific counter:
```json
{
  "type": "unsubscribe",
  "data": "counter:order_confirmation_subtotal"
}
```

Unsubscribe from chat:
```json
{
  "type": "unsubscribe",
  "data": "chat"
}
```

Unsubscribe from all polls:
```json
{
  "type": "unsubscribe",
  "data": "poll"
}
```

### Broadcasting chat messages: `chat`
You may send out chat mesasges to users, as well as receive messages (once you've subscribed to the `chat` event).

Sending a chat message:
```json
{
  "type": "chat",
  "data": "Chat message goes here :)"
}
```

When you are subscribed to the `chat` event, whenever a message is broadcast by a user, you will receive a `chat` payload:
```json
{
  "type": "chat",
  "data": {
    "message": "Chat message goes here :)",
    "user": {
      "suffix": 87,
      "properties":{...}
    }
  }
}
```

The user key within the data corresponds to the user who sent the message. Do note that only public properties are sent out in the properties key (ie: any property that doesn't start with `_`).

### Casting a vote: `poll`
You may cast any vote onto any poll. Polls are automatically created if they do not exist.
Upon a vote being cast, anyone registering to the poll's id (or to the generic `poll` event) will receive poll statistics.

Casting a vote of "hello" on poll id "test poll"
```json
{
  "type": "poll",
  "data": {
    "id": "test poll",
    "answer": "hello
  }
}
```

Data received after a vote has been cast, broadcast to all subscribers.
```json
{
  "type": "poll",
  "data": {
    "id": "test poll",
    "stats": {
      "hello": 14,
      "goodbye": 2
    }
  }
}
```

### Casting an ephemeral vote: `ephemeralPoll`
Ephemeral Polls work exactly like polls, except a user's vote is automatically removed when the user disconnects. 
The same payloads are used, except replace the type `poll` with `ephemeralPoll`

### Incrementing (or decrementing) a counter: `counter`
You may increment or decrement any counter's value. Similarly to polls, if a counter ID does not exist, one is created automatically upon trying to increment or decrement id.

Incrementing counter id "order_subtotals" by 17.75:

```json
{
  "type": "counter",
  "data": {
    "id": "order_subtotals",
    "value": 17.75
  }
}
```
Decrementing counter id "order_subtotals" by 15.14:

```json
{
  "type": "counter",
  "data": {
    "id": "order_subtotals",
    "value": -15.14
  }
}
```

When someone subscribes to a `counter` event, the server will send out the following payload every time the counter's value changes:
```json
{
  "type": "counter",
  "data": {
    "id": "order_subtotals",
    "value": "1442377.78"
  }
}
```

### Receving server configuration changes: `config`
Upon connecting, and whenever the server's configuration changes, the server will emit a `config` event.
The config is a string; Each config is different per room, and depends on what the intended use case of the application is.

Example payload:
```json
{
  "type": "config",
  "data": "{}"
}
```

### Receving server broadcasts: `broadcast`
Some rooms may send out a `broadcast` event. 

Example payload:
```json
{
  "type": "broadcast",
  "data": {
    "anything": "can",
    "be": ["sent", "by", "the", "server"]
  }
}
```

### User roles: `authenticate`
By default, users inherit the `user` role.
You can change to an `admin` role by calling `authenticate` and passing along the current (UTC) timestamp and the SHA-256 hexadecimal hash of `{ROOMNAME}{TIMESTAMP_IN_MILISECONDS}{SIGNING_KEY}`.

For example, for the room `testRoom`, the timestamp `1631756233699` and the signing key `deadbeef`, you would need to compute the SHA-256 value of `testRoom1631756233699deadbeef` (which is: `89d88bb54565ea81c0d31c817eddba48c2fbbb0414fb4bb87c799bb2e824804a`).
Once computed, send out the following payload:
```json
{
  "type": "authenticate",
  "data": {
    "ts": "1631756233699",
    "key": "89d88bb54565ea81c0d31c817eddba48c2fbbb0414fb4bb87c799bb2e824804a"
  }
}
```

Upon success, the server will send out a `profile` payload containing `"role": "admin"`.

Here's a sample Javascript implementation (relying on web crypto). Do note that the server won't honor authentication requests with a timestamp more than 5 minutes into the future or into the past.
```js
const roomName = 'testRoom';
const signingKey = 'deadbeef';

const now = new Date();
const utcNow = new Date( now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds() );

const plaintextKey = new TextEncoder().encode(`${roomName}${utcNow.getTime()}${signingKey}`)

const digest = await crypto.subtle.digest(
  {
    name: "SHA-256",
  },
  plaintextKey
);
const authenticationKey = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');


console.log('The authentication key is', authenticationKey, 'and the payload should be', {
  type: 'authenticate',
  data: {
    ts: utcNow.getTime(),
    key: authenticationKey
  }
})
```

### Emitting broadcasts as the server: `broadcast`
Once successfully connected to the server as an admin through the `authenticate` call, you will be able to send out broadcast messages as the server.

Using the `broadcast` call, you can essentially simulate any payload type. You can even come up with your own if you choose to.

Example payload:
```json
{
  "type": "broadcast",
  "data": {
    "type": "whatsup",
    "data": [
      1,
      2,
      "abc"
    ]
  }
}
```

Users will receive:
```json
{
  "type": "whatsup",
  "data": [
    1,
    2,
    "abc"
  ]
}
```

Note that you can also target the broadcast messages to users subscribing to specific events by adding a `to` property. The following example will broadcast messages to users subscribing to the "weather" event:
```json
{
  "type": "broadcast",
  "data": {
    "to": "weather",
    "type": "weather_forecast",
    "data": "Cloudy with a chance of meatballs"
  }
}
```

### Changing the room's configuration
Once successfully connected to the server as an admin through the `authenticate` call, you will be able to update the server's configuration. Updates to the configuration are saved in the underlying durable object storage, and sent out to every user upon changes and upon connecting.

Due to the underlying storage engine, the configuration can only be a string. Nothing stops you from `JSON.stringify`ing it beforehand though.

```json
{
  "type": "config",
  "data": "{}"
}
```
