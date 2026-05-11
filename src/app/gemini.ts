import { Injectable } from '@angular/core';
import { GoogleGenAI, Type } from '@google/genai';
import { ClassSession } from './models';
import { environment } from '../environments/environment';

declare const GEMINI_API_KEY: string | undefined;

@Injectable({ providedIn: 'root' })
export class GeminiService {
  private getClient() {
    let key: string | undefined;
    
    // 1. Try Environment (Baked in during build)
    if (environment.GEMINI_API_KEY && environment.GEMINI_API_KEY !== 'REPLACE_ME_GEMINI_API_KEY') {
      key = environment.GEMINI_API_KEY;
    }

    // 2. Try global variable (AI Studio Preview Environment)
    if (!key) {
      try {
        if (typeof GEMINI_API_KEY !== 'undefined' && GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY') {
          key = GEMINI_API_KEY;
        }
      } catch (e) {}
    }

    // 3. Try localStorage (Manual input fallback)
    if (!key || key === 'undefined') {
      key = localStorage.getItem('user_gemini_key') || undefined;
    }

    if (!key) {
      throw new Error('ยังไม่ได้ตั้งค่า API Key สำหรับ AI กรุณาตรวจสอบในหน้าตั้งค่า หรือใส่ GEMINI_API_KEY ใน GitHub Secrets');
    }

    return new GoogleGenAI({ apiKey: key });
  }

  async parseScheduleImage(base64Image: string, mimeType: string): Promise<ClassSession[]> {
    try {
      const ai = this.getClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
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
      
      const text = response.text;
      if (!text) throw new Error('No text returned from Gemini');
      
      const parsed = JSON.parse(text);
      return parsed;
    } catch (error) {
      console.error('Error parsing schedule with Gemini:', error);
      throw error;
    }
  }
}
