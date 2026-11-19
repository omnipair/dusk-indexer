/** Isolate archived layout-17 arithmetic from the active successor pin. */
import { resolve } from 'node:path';
if (!process.env.NODE_TEST_CONTEXT) throw new Error('Historical fixture pin is restricted to Node test workers');
process.env.DUSK_PROTOCOL_DIR=resolve(__dirname,'../../../protocol/archive/mainnet-2026-11-14');
