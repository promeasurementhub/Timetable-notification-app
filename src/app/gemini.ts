import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { ClassSession } from './models';
import { environment } from '../environments/environment';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { AppStore } from './store';

@Injectable({ providedIn: 'root' })
export class GeminiService {
  private http = inject(HttpClient);
  private store = inject(AppStore);

  private async getPref(key: string, fallback = ''): Promise<string> {
    if (Capacitor.isNativePlatform()) {
      try {
        const { value } = await Preferences.get({ key });
        return value || fallback;
      } catch {
        return fallback;
      }
    } else if (typeof window !== 'undefined') {
      return localStorage.getItem(key) || fallback;
    }
    return fallback;
  }

  async parseScheduleImage(base64Image: string, mimeType: string): Promise<ClassSession[]> {
    const localGeminiKey = (await this.getPref('user_gemini_key')).trim();
    
    // หากเข้าใช้งานผ่านคีย์ตัวเองจาก Client หรือบิวต์ใน APK โดยไม่ผ่านส่วนหลังบ้าน
    if (localGeminiKey) {
      console.log('[GeminiService] Local API Key found. Parsing directly using client-side SDK via REST...');
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${localGeminiKey}`;
        const b64Data = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;
        
        const payload = {
          contents: [{
            parts: [
              {
                inlineData: {
                  data: b64Data,
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
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  id: { type: 'STRING', description: 'Generate a unique string ID' },
                  dayOfWeek: { type: 'STRING', description: 'Day of week in English, e.g., Monday' },
                  startTime: { type: 'STRING', description: 'Start time in HH:MM format' },
                  endTime: { type: 'STRING', description: 'End time in HH:MM format' },
                  subjectCode: { type: 'STRING', description: 'Subject code (e.g., TH31101)' },
                  subjectName: { type: 'STRING', description: 'Subject name in Thai (e.g., ภาษาไทยพื้นฐาน). Leave empty if not explicitly written.' },
                  room: { type: 'STRING', description: 'Room number or name' },
                  teacher: { type: 'STRING', description: 'Teacher name' },
                },
                required: ['id', 'dayOfWeek', 'startTime', 'endTime', 'subjectCode', 'subjectName', 'room', 'teacher'],
              }
            }
          }
        };

        const response: unknown = await lastValueFrom(this.http.post(url, payload));

        const resObj = response as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        if (!resObj || !resObj.candidates || !resObj.candidates[0]?.content?.parts?.[0]?.text) {
          throw new Error('ไม่ได้รับข้อมูลผลลัพธ์จากข้อความตอบกลับของ Gemini');
        }

        const rawText = resObj.candidates[0].content.parts[0].text;
        const parsed = JSON.parse(rawText) as ClassSession[];
        return parsed || [];
      } catch (err: unknown) {
        console.error('[GeminiService] Error during client-side Gemini parse:', err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`เกิดข้อผิดพลาดในการประมวลผลด้วยคีย์ AI ส่วนตัวบิวต์อิน: ${errorMsg}`);
      }
    }

    // กรณีปกติ: เรียกผ่าน Proxy ไปยัง Back-end Server
    try {
      const savedBackendUrl = (await this.getPref('backend_api_url')).trim();
      
      let defaultApiUrl = '';
      if (typeof window !== 'undefined') {
        defaultApiUrl = window.location.origin;
      }
      if (Capacitor.isNativePlatform()) {
        defaultApiUrl = 'https://ais-pre-5ce7x4ii37m5xmqzzudf4v-123885007893.asia-southeast1.run.app';
      }
      
      const apiBaseUrl = (savedBackendUrl || this.store.globalConfig()?.backendApiUrl || (environment as { API_URL?: string }).API_URL || defaultApiUrl).replace(/\/$/, '');
      
      console.log(`[GeminiService] Directing schedule parse request to API host: ${apiBaseUrl}`);
      
      const payload = {
        base64Image,
        mimeType
      };

      const response = await lastValueFrom(
        this.http.post<ClassSession[]>(`${apiBaseUrl}/api/gemini/parse`, payload)
      );

      return response ?? [];
    } catch (error: unknown) {
      console.error('Error parsing schedule via backend API:', error);
      
      const err = error as { message?: string; error?: { message?: string; error?: string } };
      const errMsg = err.error?.message || err.error?.error || err.message || String(error);
      const lowMsg = errMsg.toLowerCase();
      
      if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || lowMsg.includes('quota') || lowMsg.includes('too many requests')) {
        throw new Error('ขออภัย ระบบมีการใช้งาน AI เกินโควต้าฟรีที่กำหนดชั่วคราว กรุณารอสักครู่ (ประมาณ 1 นาที) แล้วลองใหม่อีกครั้ง');
      } else if (errMsg.includes('503') || lowMsg.includes('unavailable') || lowMsg.includes('high demand') || lowMsg.includes('spikes in demand')) {
        throw new Error('ระบบ AI ของเซิร์ฟเวอร์มีผู้ใช้งานหนาแน่นหรือเครือข่ายขัดข้องชั่วคราว กรุณากดลองใหม่อีกครั้งเพื่อส่งวิเคราะห์ตารางเรียน');
      } else {
        throw new Error(`เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ AI: ${errMsg}`);
      }
    }
  }
}
