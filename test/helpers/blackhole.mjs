// A TCP port that never answers (a firewall dropping the packets): the
// accept queue is filled and the event loop blocked, so the kernel drops
// every new SYN. Prints its port, then blocks for argv[2] ms.
import net from 'node:net';

const server = net.createServer();
server.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
  process.stdout.write(`${server.address().port}\n`);
  const end = Date.now() + Number(process.argv[2] ?? 5000);
  while (Date.now() < end) {
    // Blocked: nothing is ever accepted.
  }
  process.exit(0);
});
