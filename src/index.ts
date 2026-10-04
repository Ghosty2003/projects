import { Node } from './node.js';
import { createHttpServer } from './server.js';

const difficulty = Number(process.env.DIFFICULTY ?? '3');
const port = Number(process.env.PORT ?? '3000');

const node = new Node({ difficulty });
createHttpServer(node).listen(port, () => {
  console.log(`blockchain node listening on http://localhost:${port} (difficulty=${difficulty})`);
});
