import { wrap, send, HttpError, EVENT_SLUGS } from '../lib/http.js';
import { listCompetitions } from '../lib/passes.js';

export default wrap(async (req, res) => {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const event = new URL(req.url, 'http://x').searchParams.get('event');
  if (event && event !== 'none' && !EVENT_SLUGS[event]) throw new HttpError(404, 'Unknown event');
  const competitions = await listCompetitions({ eventSlug: event });
  send(res, 200, { event, eventName: event ? EVENT_SLUGS[event] : null, competitions });
});
