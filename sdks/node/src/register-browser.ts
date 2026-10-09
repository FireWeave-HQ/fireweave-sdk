/** Browser build of @fireweaveai/server-sdk/register: fails loudly, never starts. */
import { FireweaveError } from './index.js';

throw new FireweaveError('Configuration', {
  message: '[fireweave] @fireweaveai/server-sdk/register is for server runtimes. Browser apps use @fireweaveai/web-sdk.',
});
