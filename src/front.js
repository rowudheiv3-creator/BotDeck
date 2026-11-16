import net from 'node:net';

/**
 * One TCP port that speaks both plain HTTP and HTTPS: the first byte of a TLS connection is 0x16.
 * Hosting panels often give a single port, and the microphone needs HTTPS.
 */
export function createFrontServer(httpServer, httpsServer) {
  return net.createServer({ pauseOnConnect: true }, (sock) => {
    sock.setTimeout(15000, () => sock.destroy()); // nothing sent: drop
    sock.on('error', () => {});
    sock.once('readable', () => {
      const b = sock.read(1);
      if (!b) return sock.destroy();
      sock.unshift(b);
      sock.setTimeout(0);
      (b[0] === 0x16 && httpsServer ? httpsServer : httpServer).emit('connection', sock);
      sock.resume();
    });
  });
}
