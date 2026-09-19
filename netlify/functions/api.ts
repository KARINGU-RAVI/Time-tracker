/**
 * The whole REST API as one Netlify Function. All logic lives in backend/src; this file only exposes it.
 * netlify.toml rewrites /api/* to this function, so the site and the API share one origin.
 */
import { createHandler } from '../../backend/src/lambda';

export const handler = createHandler();
