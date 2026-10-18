// Jest-only stand-in for uuid@14, pulled in by @langchain/community 1.x.
// uuid 14 ships ESM-only (`"type": "module"`, dist-node/index.js); the suite's
// CJS jest runtime can't parse it when community's .cjs dist does
// `require('uuid')`. jest.config.js maps `^uuid$` here. The production build
// is real ESM and resolves the actual package — this file never ships.
import { randomUUID } from 'crypto';

export const v4 = (): string => randomUUID();
export const NIL = '00000000-0000-0000-0000-000000000000';
export const MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export default { v4, NIL, MAX };
