import net from 'net';
import { expect } from 'chai';
import * as proxyProtocol from 'proxy-protocol-js';
import tUtil from './utils';
import { ProxyHeaders } from '../src';

for (const serverType of ['net', 'http', 'https']) {
  console.log('Testing', serverType);
  try {
    for (const protocolVersion of [1, 2] as const) {
      const proxyProtocolEncode = (headers: ProxyHeaders): string | Uint8Array => {
        if (protocolVersion === 1) {
          return new proxyProtocol.V1ProxyProtocol(
            proxyProtocol.INETProtocol.TCP4,
            new proxyProtocol.Peer(headers.remoteAddress, headers.remotePort),
            new proxyProtocol.Peer(headers.localAddress, headers.localPort)
          ).build();
        } else {
          return new proxyProtocol.V2ProxyProtocol(
            proxyProtocol.Command.LOCAL,
            proxyProtocol.TransportProtocol.DGRAM,
            new proxyProtocol.IPv4ProxyAddress(
              proxyProtocol.IPv4Address.createFrom(headers.remoteAddress.split('.').map((p) => parseInt(p))),
              headers.remotePort,
              proxyProtocol.IPv4Address.createFrom(headers.localAddress.split('.').map((p) => parseInt(p))),
              headers.localPort
            )
          ).build();
        }
      };

      describe(`PROXY Protocol v${protocolVersion} server: ${serverType}`, function () {
        const server = tUtil.createServer(serverType, { strict: true });
        it('Check socket is established correctly', function () {
          return tUtil.fakeConnect(server);
        });

        it('Check with another socket parameters', function () {
          return tUtil.fakeConnect(server, {
            headers: proxyProtocolEncode({
              localAddress: '192.168.0.1',
              localPort: 3350,
              remoteAddress: '192.168.0.254',
              remotePort: 443,
            }),
          });
        });

        it(`Check with another socket parameters as a string in v${protocolVersion} format`, function () {
          return tUtil.fakeConnect(server, {
            header: proxyProtocolEncode({
              remoteAddress: '192.168.0.254',
              localAddress: '192.168.0.1',
              localPort: 443,
              remotePort: 3350,
            }),
          });
        });

        it('Check with IPv6 IP', function () {
          return tUtil.fakeConnect(server, {
            headers: proxyProtocolEncode({
              localAddress: 'fe80::a00:27ff:fe9f:4016',
              localPort: 3350,
              remoteAddress: 'fe80::a089:a3ff:fe15:e992',
              remotePort: 443,
            }),
          });
        });

        describe('Should detect a malformed PROXY headers', function () {
          it("Header without IP's", function () {
            return tUtil
              .fakeConnect(server, {
                header: 'PROXY HACK ATTEMPT\r\n',
              })
              .then(
                function () {
                  throw new Error("It shouldn't get fulfilled");
                },
                function (err) {
                  expect(err.message).to.be.equal('PROXY protocol malformed header');
                }
              );
          });

          if (serverType === 'net') {
            it('non-proxy connection when in non-strict mode should not be destroyed #7', function () {
              return tUtil.fakeConnect(tUtil.createServer(serverType, { strict: false }), {
                header: 'TELNET BABY',
              });
            });
          }

          it('Restore emitted events after socket.destroy #5', function () {
            return tUtil
              .fakeConnect(server, {
                header: 'PRO',
                autoCloseSocket: false,
                testAttributes: false,
              })
              .then(
                function () {
                  throw new Error("It shouldn't get fulfilled");
                },
                function (err) {
                  expect(err.message).to.be.equal('non-PROXY protocol connection');
                }
              );
          });

          it('should drop connection gracefully when non-proxy connection is gathered when `ignoreStrictExceptions` is active. #11', function (cb) {
            const server = tUtil.createServer(serverType, {
              strict: true,
              ignoreStrictExceptions: true,
            });

            server.once('listening', function () {
              const client = new net.Socket();

              client.on('end', cb);

              client.once('connect', function () {
                // Send header and body
                client.write('GET / HTTP/1.0\n\n');
              });

              client.connect(server.port, server.host);
            });
          });
          if (serverType !== 'net') {
            it('proxy socket timeout should work', (done) => {
              const server = tUtil.createServer(serverType, {
                strict: false,
                ignoreStrictExceptions: true,
              });
              server.setTimeout(500);
              expect(server.timeout).to.equal(500);

              server.once('listening', function () {
                const client = new net.Socket();

                client.on('end', done);

                client.once('connect', function () {
                  client.write('GET /');
                });

                client.connect(server.port, server.host);
              });
            });

            /*
          
          it('socket timeout should work', (done) => {
            const server = require(serverType).createServer();
            const port = Math.floor(Math.random() * 5000 + 20000) ;
            server.listen(port);
            server.setTimeout(500);
            expect(server.timeout).to.equal(500);
            server.once('listening', function () {
              const client = new net.Socket()
              client.on('end', done)
              client.once('connect', function () {
                client.write('GET /')
              })
              client.connect(port, server.host)
            })
          })
          */
          }
        });
      });
    }
  } catch (e) {
    console.error(e);
  }
}
