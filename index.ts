import dotenv from 'dotenv';
import { ClawlessApp } from './app/ClawlessApp.js';
import { logError } from './utils/error.js';

// Load environment variables
dotenv.config();

const app = new ClawlessApp();

app.launch().catch((error: any) => {
  logError('Bot launch failed unexpectedly:', error);
  process.exit(1);
});
