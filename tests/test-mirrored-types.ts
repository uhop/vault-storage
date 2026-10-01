import test from 'tape-six';
import {MIRRORED_EDGE_TYPES} from '../src/records/types.ts';
// @ts-expect-error: TS7016, the UI's modules are untyped JavaScript.
import {SYMMETRIC_TYPES} from '../static/ui/note-links.js';

test("the UI's mirrored edge types are the server's", t => {
  t.deepEqual([...SYMMETRIC_TYPES].sort(), [...MIRRORED_EDGE_TYPES].sort());
});
