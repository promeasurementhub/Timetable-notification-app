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

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
    
    // Add simple retry logic for 429 Too Many Requests
    let response;
    let retries = 2;
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
                '2. If a subject name is missing but a subject code is present, try to infer the subject name or leave it to be the same as the code.\n' +
                '3. Convert Day of Week to English like "Monday", "Tuesday", etc. (for internal logic).\n' +
                '4. Ensure startTime and endTime are in "HH:MM" 24h format.\n' +
                '5. If the schedule is in a grid, carefully map the times to the correct days.'
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
                  subjectName: { type: Type.STRING, description: 'Subject name in Thai (e.g., ภาษาไทยพื้นฐาน). If not explicitly written, infer from code if possible.' },
                  room: { type: Type.STRING, description: 'Room number or name' },
                  teacher: { type: Type.STRING, description: 'Teacher name' },
                },
                required: ['id', 'dayOfWeek', 'startTime', 'endTime', 'subjectCode', 'subjectName', 'room', 'teacher'],
              }
            }
          }
        });
        break; // Sucess, break out of retry loop
      } catch (err: any) {
        if (retries === 0 || err.status !== 429) {
          throw err;
        }
        console.warn(`[Gemini API] Rate limited. Retrying... (${retries} attempts left)`);
        await new Promise(r => setTimeout(r, 2000)); // wait 2 seconds before retry
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
  } catch (error: any) {
    if (error?.status === 429) {
      console.error('[Gemini API] Failed to parse: Quota exceeded (429).');
      res.status(429).json({ error: 'RESOURCE_EXHAUSTED', message: error.message || String(error) });
    } else {
      console.error('Error parsing schedule with Gemini:', error);
      res.status(500).json({ error: error.message || String(error) });
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
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
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
