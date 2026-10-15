// Local preview with an in-memory database and a fake Stripe. Run: npm run dev
import { startServer } from './tests/harness.js';
const s = await startServer({ port: 3000 });
console.log(`Local preview: ${s.base}  (in-memory data, fake payments, setup key: ${process.env.ADMIN_SETUP_KEY})`);
