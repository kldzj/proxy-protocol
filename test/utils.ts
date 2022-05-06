import fs from 'fs';
import { Socket } from 'net';
import { expect } from 'chai';
import * as proxyProtocol from 'proxy-protocol-js';
import ProxyWrap, { ProxyOptions } from '../src';

function isSecureProtocol(protocol: string) {
  return protocol === 'https' || protocol == 'spdy' || protocol == 'http2';
}

const protocols: Record<string, any> = {
  net: require('net'),
  http: require('http'),
  https: require('https'),
  http2: require('http2'),
};

const secureOptions = {
  key: fs.readFileSync('test/fixtures/key.pem'),
  cert: fs.readFileSync('test/fixtures/cert.pem'),
};

const defaults = {
  fakeConnect: {
    protocol: 'TCP4',
    autoCloseSocket: true,
    testAttributes: true,
    clientAddress: '10.10.10.1',
    proxyAddress: '10.10.10.254',
    remoteAddress: '10.10.10.1',
    clientPort: 12456,
    proxyPort: 80,
    headerJoinCRLF: true,
  },
};

export default {
  createServer: function (p: any, options: Partial<ProxyOptions>) {
    const pc = protocols[p];
    const proxy = ProxyWrap(pc, options);
    const server = proxy.createServer(isSecureProtocol(p) ? secureOptions : {});
    const port = Math.floor(Math.random() * 5000 + 20000); // To be sure that the port is not beeing used on test side
    const host = '127.0.0.1';

    server._protocol = p;
    server._protocolConstructor = pc;
    server.host = host;
    server.port = port;

    // Start server on localhost/random-port
    server.listen(port, host);

    // Returns server
    return server;
  },

  fakeConnect: function (server: any, options?: any) {
    const p = server._protocol;

    // Prepare options
    options = {
      ...defaults.fakeConnect,
      ...options,
    };
    let header: Buffer | null;
    if (!options.header) {
      header = Buffer.from(
        new proxyProtocol.V2ProxyProtocol(
          proxyProtocol.Command.LOCAL,
          proxyProtocol.TransportProtocol.DGRAM,
          new proxyProtocol.IPv4ProxyAddress(
            proxyProtocol.IPv4Address.createFrom(options.clientAddress.split('.').map((p: string) => parseInt(p))),
            options.clientPort,
            proxyProtocol.IPv4Address.createFrom(options.proxyAddress.split('.').map((p: string) => parseInt(p))),
            options.proxyPort
          )
        ).build()
      );
    } else {
      header = Buffer.from(options.header);
    }

    const body = Buffer.from(['GET /something/cool HTTP/1.1', 'Host: www.stratum.to'].join('\n'));

    return new Promise<void>(function (fulfill, reject) {
      if (typeof server.listening == 'boolean') {
        if (server.listening) {
          fulfill();
        } else {
          server.once('listening', () => fulfill());
          server.once('error', () => reject());
        }
      } else {
        fulfill();
      }
    }).then(function () {
      return new Promise(function (fulfill, reject) {
        const client = new protocols.net.Socket(),
          host = server.host,
          port = server.port;
        const value = [undefined, client];

        server.once('connection', function (socket: Socket) {
          socket.on('error', function (err: Error) {
            reject(err);
          });
        });

        server.once('proxiedConnection', function (socket: Socket) {
          value[0] = socket;

          socket.on('error', function (err: Error) {
            reject(err);
          });

          if (options.testAttributes && !options.header) {
            try {
              expect((socket as any).clientAddress).to.be.equal(options.clientAddress, 'Client address does not match');
              expect((socket as any).proxyAddress).to.be.equal(options.proxyAddress, 'Proxy address does not match');
              expect((socket as any).clientPort).to.be.equal(options.clientPort, 'Client port does not match');
              expect((socket as any).proxyPort).to.be.equal(options.proxyPort, 'Proxy port does not match');
              if (server.proxyOptions.overrideRemote) {
                expect(socket.remoteAddress).to.be.equal(options.clientAddress, 'Remote address does not match');
                expect(socket.remotePort).to.be.equal(options.clientPort, 'Remote port does not match');
              }
            } catch (err) {
              reject(err);
            }
          }

          if (options.autoCloseSocket && !isSecureProtocol(p)) {
            socket.end();
          } else {
            fulfill(value);
          }
        });

        client.once('connect', function () {
          // Send header and body
          client.write(Buffer.concat([header ?? Buffer.from(''), body]));
        });

        if (options.autoCloseSocket) {
          client.once('end', function () {
            fulfill(value);
          });
        }

        client.connect(port, host);
      });
    });
  },
};
