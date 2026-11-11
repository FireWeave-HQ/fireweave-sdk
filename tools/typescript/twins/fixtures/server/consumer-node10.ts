// TypeScript with module commonjs + moduleResolution node10, which ignores "exports".
import { start, fw } from '@fireweaveai/server-sdk-cjs/start';
import { isFireweaveError, type FireweaveErrorKind } from '@fireweaveai/server-sdk-cjs';
import '@fireweaveai/server-sdk-cjs/register';

const kind: FireweaveErrorKind = 'Configuration';
export const used = [start, fw, isFireweaveError, kind];
