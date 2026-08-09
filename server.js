// Serveur statique minimal : index.html + data.json.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const TYPES = { '.html': 'text/html', '.json': 'application/json' };

createServer(async (req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(new URL('.' + file, import.meta.url));
    res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(4321, () => console.log('http://localhost:4321'));
