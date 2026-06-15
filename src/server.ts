import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join} from 'node:path';
import cors from 'cors';
import { GoogleGenAI, Type } from '@google/genai';
import { initPushWorker, getVapidPublicKey, processNotificationQueue } from './server-push';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/api/push/vapidPublicKey', (req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

app.get('/api/push/cron', async (req, res) => {
  await processNotificationQueue();
  res.json({ success: true, message: 'Queue processed manually' });
});

const angularApp = new AngularNodeAppEngine({
  allowedHosts: [
    'localhost',
    'ais-dev-5ce7x4ii37m5xmqzzudf4v-123885007893.asia-southeast1.run.app',
    'ais-pre-5ce7x4ii37m5xmqzzudf4v-123885007893.asia-southeast1.run.app'
  ]
});

app.post('/api/gemini/parse', async (req, res) => {
  try {
    const { base64Image, mimeType } = req.body;
    if (!base64Image || !mimeType) {
      res.status(400).json({ error: 'Missing base64Image or mimeType' });
      return;
    }

    const key = process.env['GEMINI_API_KEY'];
    if (!key) {
      res.status(500).json({ error: 'GEMINI_API_KEY is not defined on the server' });
      return;
    }

    const ai = new GoogleGenAI({ apiKey: key });
    
    // Add simple retry logic for 429 Too Many Requests & 503 Service Unavailable / High Demand
    let response;
    let retries = 3; // Increase retries to 3
    while (retries >= 0) {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: {
            parts: [
              {
                inlineData: {
                  data: base64Image.split(',')[1] || base64Image,
                  mimeType: mimeType,
                }
              },
              {
                text: 'Extract the class schedule from this image. Guidelines:\n' +
                '1. Ensure all extracted text (Subject names, Teacher names) is in Thai if it appears in Thai in the image.\n' +
                '2. If a subject name is missing but a subject code is present, DO NOT try to infer the subject name. Leave it as an empty string.\n' +
                '3. Convert Day of Week to English like "Monday", "Tuesday", etc. (for internal logic).\n' +
                '4. Ensure startTime and endTime are in "HH:MM" 24h format.\n' +
                '5. If the schedule is in a grid, carefully map the times to the correct days.\n' +
                '6. If a cell/slot in the 10th period (starting at 15:40) of the grid is empty/blank in the input image, set its subjectName to "เลิกเรียน" (End of School) and keep subjectCode, room, and teacher as empty strings.'
              }
            ]
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING, description: 'Generate a unique string ID' },
                  dayOfWeek: { type: Type.STRING, description: 'Day of week in English, e.g., Monday' },
                  startTime: { type: Type.STRING, description: 'Start time in HH:MM format' },
                  endTime: { type: Type.STRING, description: 'End time in HH:MM format' },
                  subjectCode: { type: Type.STRING, description: 'Subject code (e.g., TH31101)' },
                  subjectName: { type: Type.STRING, description: 'Subject name in Thai (e.g., ภาษาไทยพื้นฐาน). Leave empty if not explicitly written.' },
                  room: { type: Type.STRING, description: 'Room number or name' },
                  teacher: { type: Type.STRING, description: 'Teacher name' },
                },
                required: ['id', 'dayOfWeek', 'startTime', 'endTime', 'subjectCode', 'subjectName', 'room', 'teacher'],
              }
            }
          }
        });
        break; // Sucess, break out of retry loop
      } catch (err: unknown) {
        const errorObject = err as { status?: number; message?: string; name?: string; code?: number };
        const status = errorObject.status || errorObject.code || 0;
        const msg = errorObject.message || '';
        const isRetryable = status === 429 || status === 503 ||
                            msg.includes('429') ||
                            msg.includes('503') ||
                            msg.toLowerCase().includes('rate limit') ||
                            msg.toLowerCase().includes('high demand') ||
                            msg.toLowerCase().includes('unavailable') ||
                            msg.toLowerCase().includes('spikes in demand');
        
        if (retries === 0 || !isRetryable) {
          throw err;
        }
        console.warn(`[Gemini API] Temporary error (status: ${status}, message: ${msg}). Retrying in 2.5 seconds... (${retries} attempts left)`);
        await new Promise(r => setTimeout(r, 2500)); // wait 2.5 seconds before retry
        retries--;
      }
    }
    
    if (!response) {
       res.status(500).json({ error: 'No response from Gemini API' });
       return;
    }

    const text = response.text;
    if (!text) {
      res.status(500).json({ error: 'No text returned from Gemini' });
      return;
    }
    
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string; code?: number; error?: { message?: string } };
    const status = err.status || err.code || 500;
    const msg = err.message || (err.error && typeof err.error === 'object' ? err.error.message : '') || String(error);
    const lowMsg = msg.toLowerCase();
    
    if (status === 429 || lowMsg.includes('429') || lowMsg.includes('quota') || lowMsg.includes('resource_exhausted') || lowMsg.includes('too many requests')) {
      console.error('[Gemini API] Failed to parse: Quota exceeded (429).');
      res.status(429).json({ error: 'RESOURCE_EXHAUSTED', message: 'ขออภัย ระบบมีการใช้งาน AI เกินโควต้าชั่วคราว กรุณารอประมาณ 1 นาทีแล้วลองใหม่อีกครั้ง' });
    } else if (status === 503 || lowMsg.includes('503') || lowMsg.includes('unavailable') || lowMsg.includes('high demand') || lowMsg.includes('spikes in demand')) {
      console.error('[Gemini API] Failed to parse: Service unavailable (503).');
      res.status(503).json({ error: 'UNAVAILABLE', message: 'ระบบ AI ของเซิร์ฟเวอร์มีผู้ใช้งานหนาแน่นหรือเกิดปัญหาการเชื่อมต่อชั่วคราวชั่วครู่ กรุณากดลองใหม่อีกครั้งเพื่อส่งคำขอประมวลผล' });
    } else {
      console.error('Error parsing schedule with Gemini:', error);
      res.status(status).json({ error: msg });
    }
  }
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  const originalHost = req.headers.host;
  const originalXForwardedHost = req.headers['x-forwarded-host'];

  // Force 'localhost' to bypass Angular Node App Engine's allowedHosts restriction
  req.headers.host = 'localhost';
  if (req.headers['x-forwarded-host']) {
    delete req.headers['x-forwarded-host'];
  }

  angularApp
    .handle(req)
    .then((response) => {
      // Restore original headers for downstream middleware
      req.headers.host = originalHost;
      if (originalXForwardedHost !== undefined) {
        req.headers['x-forwarded-host'] = originalXForwardedHost;
      }
      return response ? writeResponseToNodeResponse(response, res) : next();
    })
    .catch((err) => {
      req.headers.host = originalHost;
      if (originalXForwardedHost !== undefined) {
        req.headers['x-forwarded-host'] = originalXForwardedHost;
      }
      next(err);
    });
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  initPushWorker(); // Start 24/7 notification queue processor
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
