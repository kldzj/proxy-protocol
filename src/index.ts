import * as proxyProtocol from 'proxy-protocol-js';
import { Server, Socket } from 'net';
import ProtocolError from './errors/ProtocolError';

export interface ProxyOptions {
  strict: boolean;
  ignoreStrictExceptions: boolean;
  overrideRemote: boolean;
  timeout?: number;
}

export const defaults: ProxyOptions = {
  strict: true,
  ignoreStrictExceptions: false,
  overrideRemote: true,
};

export interface ProxyHeaders {
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
}

const proxyProtocolFields = ['remoteAddress', 'remotePort', 'clientAddress', 'clientPort', 'proxyAddress', 'proxyPort'];

const v1Header = 'PROXY';
const v2Header = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

const mapV1ProxyInfo = (info: proxyProtocol.V1ProxyProtocol): ProxyHeaders => ({
  localAddress: info.destination.ipAddress,
  localPort: info.destination.port,
  remoteAddress: info.source.ipAddress,
  remotePort: info.source.port,
});

const mapV2ProxyInfo = (info: proxyProtocol.V2ProxyProtocol): ProxyHeaders | null => {
  if (!(info.proxyAddress instanceof proxyProtocol.IPv4ProxyAddress)) {
    return null;
  }

  return {
    localAddress: info.proxyAddress.destinationAddress.address.join('.'),
    localPort: info.proxyAddress.destinationPort,
    remoteAddress: info.proxyAddress.sourceAddress.address.join('.'),
    remotePort: info.proxyAddress.sourcePort,
  };
};

const isHeaderCompleted = (buf: Buffer): [boolean, ProxyHeaders | null, Buffer] => {
  const proxyVersion = proxyProtocol.ProxyProtocolIdentifier.identify(buf);
  if (proxyVersion === proxyProtocol.ProxyProtocolVersion.V1) {
    const endOfBufferIndex = buf.indexOf('\r');
    if (endOfBufferIndex === -1) {
      return [true, null, buf];
    }

    try {
      const proxyInfo = proxyProtocol.V1ProxyProtocol.parse(buf.toString());
      return [true, mapV1ProxyInfo(proxyInfo), buf.slice(endOfBufferIndex + 2)];
    } catch (_e) {
      return [true, null, buf];
    }
  }

  if (proxyVersion === proxyProtocol.ProxyProtocolVersion.V2) {
    const addrLength = buf[15] + buf[14] * 256;

    try {
      const proxyInfo = proxyProtocol.V2ProxyProtocol.parse(buf);
      return [true, mapV2ProxyInfo(proxyInfo), buf.slice(16 + addrLength)];
    } catch (_e) {
      return [true, null, buf];
    }
  }

  if (proxyVersion === proxyProtocol.ProxyProtocolVersion.NOT) {
    return [true, null, buf];
  }

  return [false, null, buf];
};

function createTLSSocketPropertyGetter(tlsSocket: any, propertyName: string) {
  return function () {
    return tlsSocket._parent[propertyName];
  };
}

function defineProperty(target: any, propertyName: string, getter: () => any) {
  Object.defineProperty(target, propertyName, {
    enumerable: false,
    configurable: true,
    get: getter,
  });
}

function defineSocketProperties(socket: Socket, proxyInfo: ProxyHeaders, overrideRemote: boolean) {
  const socketParams = {
    clientAddress: proxyInfo.remoteAddress,
    proxyAddress: proxyInfo.localAddress,
    clientPort: proxyInfo.remotePort,
    proxyPort: proxyInfo.localPort,
  };

  for (const [propertyName, propertyValue] of Object.entries(socketParams)) {
    defineProperty(socket, propertyName, () => propertyValue);
  }

  if (overrideRemote) {
    defineProperty(socket, 'remoteAddress', () => socketParams.clientAddress);
    defineProperty(socket, 'remotePort', () => socketParams.clientPort);
  }
}

// Wraps the given module (ie, http, https, net, tls, etc) interface so that
// `socket.remoteAddress` and `remotePort` work correctly when used with the
// PROXY protocol (http://haproxy.1wt.eu/download/1.5/doc/proxy-protocol.txt)
// strict option drops requests without proxy headers, enabled by default to match previous behavior, disable to allow both proxied and non-proxied requests
export default function <T extends Record<string, any>>(iface: T, _options?: Partial<ProxyOptions>): T {
  if (!iface) throw new Error(`iface is null/undefined`);
  const exports: Record<string, any> = {};
  let sockets: Socket[] = [];

  const options: ProxyOptions = {
    ...defaults,
    ..._options,
  };

  exports.options = options;

  const replaceListeners = (server: Server) => {
    // remove the connection listener attached by iface.Server and replace it with our own.
    const connectionListeners = server.listeners('connection') as ((...args: any[]) => void)[];
    server.removeAllListeners('connection');
    server.addListener('connection', connectionListener);

    // add the old connection listeners to a custom event, which we'll fire after processing the PROXY header
    for (const connectionListener of connectionListeners) {
      server.addListener('proxiedConnection', connectionListener);
    }

    // changing secure connection listeners to set remoteAddress property on socket
    const secureConnectionListeners = server.listeners('secureConnection');
    server.removeAllListeners('secureConnection');

    for (const secureConnectionListener of secureConnectionListeners) {
      server.addListener(
        'secureConnection',
        createSecureConnectionListener(server, secureConnectionListener as (...args: any[]) => void)
      );
    }

    server.addListener('close', () =>
      sockets.forEach((socket) => {
        socket.end();
        socket.destroy();
      })
    );

    const filterSocket = (socket: Socket) => {
      sockets = sockets.filter((s) => s !== socket);
    };

    server.addListener('proxiedConnection', filterSocket);
    server.addListener('connection', (socket) => {
      sockets.push(socket);
      socket.on('close', () => {
        filterSocket(socket);
        socket.off('proxiedConnection', filterSocket);
      });
    });
  };

  // copy iface's exports to myself
  for (const k in iface) exports[k] = iface[k];
  ['createServer', 'createSecureServer']
    .filter((method) => iface[method])
    .forEach((method) => {
      exports[method] = function (...args: any[]) {
        const server = iface[method](...args);
        server.proxyOptions = options;
        replaceListeners(server);
        return server;
      };
    });

  function connectionListener(socket: Socket) {
    // @ts-ignore
    const self = this;
    const realEmit = socket.emit;
    let history: any[] | null = [];
    let protocolError = false;
    if ((self.timeout ?? options.timeout) && (socket as any).timeout === undefined) {
      socket.setTimeout(self.timeout ?? options.timeout, () => socket.end());
    }

    // override the socket's event emitter so we can process data (and discard the PROXY protocol header) before the underlying Server gets it
    (socket as any).emit = (function () {
      let isReadable: boolean;

      return (event: string, ...rest: any[]) => {
        history?.push([event, ...rest]);

        if (event === 'readable') {
          isReadable = true;
          return onReadable();
        }
        // Only needed for node.js 0.10
        if (event === 'end' && !isReadable) {
          self.emit('proxiedConnection', socket);
          restore();
        }
        if (event === 'timeout') {
          realEmit.apply(socket, [event]);
        }
      };
    })();

    function restore() {
      if (socket.emit === realEmit || !history) return;

      // if (legacy) socket.removeListener('data', ondata);
      // restore normal socket functionality, and fire any events that were emitted while we had control of emit()
      socket.emit = realEmit;
      for (let i = 0; i < history.length; i++) {
        realEmit.apply(socket, history[i]);
        if (history[i][0] == 'end' && (socket as any).onend) (socket as any).onend();
      }
      history = null;
    }

    function destroy(error: Error | ProtocolError | string, wasStrict: boolean) {
      // Set header on error
      const _error = new ProtocolError(typeof error === 'string' ? error : error.message);
      _error.header = buf.toString('ascii');

      protocolError = true;
      socket.destroy(wasStrict ? (!options.ignoreStrictExceptions && _error) || undefined : _error);
      restore();
    }

    socket.on('error', realEmit);
    socket.on('readable', onReadable);

    let buf = Buffer.alloc(0);

    function onReadable() {
      let chunk;
      chunk = socket.read();

      if (chunk === null && buf.length === 0) {
        // unshifting will fire the readable event
        socket.emit = realEmit;
        self.emit('proxiedConnection', socket);
        return;
      }

      while (chunk !== null) {
        buf = Buffer.concat([buf, chunk]);
        // if the first 5 bytes aren't PROXY, something's not right.
        if (
          buf.length >= Math.max(v1Header.length, v2Header.length) &&
          !buf.slice(0, v1Header.length).equals(Buffer.from(v1Header)) &&
          !buf.slice(0, v2Header.length).equals(Buffer.from(v2Header))
        ) {
          protocolError = true;
          if (options.strict) {
            return destroy('non-PROXY protocol connection', true);
          }
        }

        const [headerCompleted, proxyInfo, bufferRest] = isHeaderCompleted(buf);
        if (headerCompleted || protocolError) {
          socket.removeListener('error', realEmit);
          socket.removeListener('readable', onReadable);

          if (options.strict && !proxyInfo) {
            return destroy('PROXY protocol malformed header', true);
          }

          if (!protocolError && proxyInfo) {
            defineSocketProperties(socket, proxyInfo, options.overrideRemote);
          }

          // unshifting will fire the readable event
          socket.emit = realEmit;
          socket.unshift(bufferRest);

          self.emit('proxiedConnection', socket);

          restore();

          if ((socket as any).ondata) {
            const data = socket.read();

            if (data) {
              (socket as any).ondata(data, 0, data.length);
            }
          }

          return;
        }

        if (buf.length > 107) {
          return destroy('PROXY header too long', false);
        }

        chunk = socket.read();
      }
    }
  }

  function createSecureConnectionListener(context: Server, listener: (...args: any[]) => void) {
    return function (socket: Socket) {
      const properties = proxyProtocolFields;
      defineTLSSocketProperties(socket, properties);
      listener.call(context, socket);
    };
  }

  function defineTLSSocketProperties(tlsSocket: Socket, properties: string[]) {
    for (const propertyName of properties) {
      const getter = createTLSSocketPropertyGetter(tlsSocket, propertyName);
      defineProperty(tlsSocket, propertyName, getter);
    }
  }

  return exports as T;
}
