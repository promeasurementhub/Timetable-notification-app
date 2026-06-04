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
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, getDoc, doc, setDoc, Firestore } from 'firebase/firestore';
import { readFileSync } from 'node:fs';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize Firebase on server side so that Express backend can track schedules and send notifications
const configPath = join(process.cwd(), 'firebase-applet-config.json');
let firebaseAppConfig;
try {
  firebaseAppConfig = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  console.warn('Failed to load firebase config at server startup:', e);
}

let db: Firestore | null = null;
if (firebaseAppConfig) {
  try {
    const firebaseApp = initializeApp(firebaseAppConfig);
    db = getFirestore(firebaseApp, firebaseAppConfig.firestoreDatabaseId);
    console.log('[Server] Firebase successfully initialized on Node Express backend.');
  } catch (err) {
    console.error('[Server] Failed to initialize Firebase on Node side:', err);
  }
}

// Endpoint to retrieve client's actual device IP address 
app.get('/api/ip', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const clientIp = typeof ip === 'string' ? ip.split(',')[0].trim() : String(ip);
  res.json({ ip: clientIp });
});

// Periodic server-side schedule checker daemon
if (db) {
  console.log('[Server Background Daemon] Launching schedule monitoring loop...');
  setInterval(async () => {
    try {
      // Get current Thailand local time (UTC+7)
      const now = new Date();
      const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
      const thaiTime = new Date(utc + (3600000 * 7));
      
      const dayMap: Record<number, string> = {
        0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday'
      };
      const currentDay = dayMap[thaiTime.getDay()];
      const currentH = thaiTime.getHours();
      const currentM = thaiTime.getMinutes();
      
      // Look up all user backups to scan schedules
      const usersSub = collection(db, 'users');
      const usersSnap = await getDocs(usersSub);
      
      for (const userDoc of usersSnap.docs) {
        const userId = userDoc.id;
        try {
          // Fetch user backup
          const dataDoc = await getDoc(doc(db, 'users', userId, 'backup', 'data'));
          if (!dataDoc.exists()) continue;
          
          const backupData = dataDoc.data();
          const { schedule, settings, active, ipAddress } = backupData;
          if (!active) continue;
          
          const preNotifyMinutes = settings?.preNotifyMinutes !== undefined ? settings.preNotifyMinutes : 3;
          
          for (const session of (schedule || [])) {
            if (session.dayOfWeek !== currentDay) continue;
            
            const startParts = (session.startTime || '').split(':');
            if (startParts.length === 2) {
              const startH = parseInt(startParts[0], 10);
              const startM = parseInt(startParts[1], 10);
              
              // Define target notification alert time
              let notifyM = startM - preNotifyMinutes;
              let notifyH = startH;
              while (notifyM < 0) {
                notifyM += 60;
                notifyH -= 1;
              }
              if (notifyH < 0) notifyH = 24 + notifyH;
              
              // If it matches current hour/minute, fire server background dispatch
              if (currentH === notifyH && currentM === notifyM) {
                const subjectName = session.subjectName || session.subjectCode || 'ไม่ระบุวิชา';
                const notifTitle = preNotifyMinutes > 0
                  ? `⏰ อีก ${preNotifyMinutes} นาทีจะเริ่มเรียน`
                  : `🔔 ได้เวลาเริ่มเรียนแล้ว`;
                  
                let notifBody = `วิชา: ${subjectName} (${session.startTime} น.)`;
                if (session.room) notifBody += ` | ห้องเรียน: ${session.room}`;
                if (session.teacher) notifBody += ` | ครูผู้สอน: ${session.teacher}`;
                
                console.log(`[ALERT DISPATCHED] User ${userId} with IP ${ipAddress || 'unknown'} has class next: ${subjectName}`);
                
                // Save actual dispatched alert to user's database. Subscribing clients (service workers/app) handle this dynamically!
                const dispatchId = `dispatch_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                const dispatchRef = doc(db, `users/${userId}/dispatched_notifications`, dispatchId);
                await setDoc(dispatchRef, {
                  id: dispatchId,
                  title: notifTitle,
                  body: notifBody,
                  dispatchedAt: new Date().toISOString(),
                  ipAddress: ipAddress || 'unknown',
                  status: 'delivered',
                  subjectName: subjectName,
                  startTime: session.startTime
                });
              }
            }
          }
        } catch (subErr) {
          console.warn(`[Background Daemon] Could not process schedule for user ${userId}:`, subErr);
        }
      }
    } catch (err) {
      console.error('[Background Daemon] Main schedule checking loop error:', err);
    }
  }, 60000); // Check once every minute
}

app.post('/api/trigger-test-alarm', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) {
      res.status(400).json({ error: 'Missing user uid' });
      return;
    }
    
    if (!db) {
      res.status(500).json({ error: 'Firestore is not initialized on the server side' });
      return;
    }
    
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const clientIp = typeof ip === 'string' ? ip.split(',')[0].trim() : String(ip);
    
    const dispatchId = `dispatch_test_${Date.now()}`;
    const dispatchRef = doc(db, `users/${uid}/dispatched_notifications`, dispatchId);
    
    await setDoc(dispatchRef, {
      id: dispatchId,
      title: '🚨 ทดสอบระบบแจ้งเตือนด่วนผ่าน Server Direct',
      body: 'ระบบยิงส่งข้อมูลสิทธิ์และสัญญาณเตือนตรงจาก Cloud Engine มายัง IP เครื่องของคุณเรียบร้อยแล้ว!',
      dispatchedAt: new Date().toISOString(),
      ipAddress: clientIp,
      status: 'delivered',
      subjectName: 'วิชาทดลอง (Server direct)',
      startTime: 'ตอนนี้'
    });
    
    res.json({ success: true, ip: clientIp, id: dispatchId });
  } catch (err: unknown) {
    const errMsg = (err as Error)?.message || String(err);
    console.error('Trigger test alarm error:', err);
    res.status(500).json({ error: errMsg });
  }
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
        const errorObject = err as { status?: number; message?: string };
        if (retries === 0 || errorObject.status !== 429) {
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
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    if (err?.status === 429) {
      console.error('[Gemini API] Failed to parse: Quota exceeded (429).');
      res.status(429).json({ error: 'RESOURCE_EXHAUSTED', message: err.message || String(error) });
    } else {
      console.error('Error parsing schedule with Gemini:', error);
      res.status(500).json({ error: err.message || String(error) });
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
if (process.env['NODE_ENV'] === 'production' || isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = 3000;
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
