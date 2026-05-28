import { Injectable, inject } from '@angular/core';
import { AppStore } from './store';
import { ClassSession, AppSettings } from './models';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private store = inject(AppStore);
  private notifiedSet = new Set<string>();
  private intervalId?: ReturnType<typeof setInterval>;

  constructor() {
    if (typeof window !== 'undefined') {
      this.requestPermission();
    }
  }

  requestPermission() {
    return new Promise<boolean>((resolve) => {
      if (typeof window !== 'undefined') {
        if (Capacitor.isNativePlatform()) {
          LocalNotifications.requestPermissions().then((permission) => {
            resolve(permission.display === 'granted');
          }).catch(err => {
            console.warn('Capacitor notifications permission error:', err);
            resolve(false);
          });
          return;
        }

        if ('Notification' in window) {
          if (Notification.permission === 'granted') {
            resolve(true);
            return;
          }
          
          Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
              import('./firebase-client').then(({ requestFirebaseNotificationPermission }) => {
                requestFirebaseNotificationPermission().then(token => {
                  if (token) {
                    console.log('Firebase Push Notifications Enabled');
                    localStorage.setItem('fcm_token_granted', 'true');
                  }
                  resolve(true);
                });
              }).catch(err => {
                console.warn('Failed to load firebase client:', err);
                resolve(true); // Still treat as granted if browser perm is ok
              });
            } else {
              resolve(false);
            }
          });
        } else {
          resolve(false);
        }
      } else {
        resolve(false);
      }
    });
  }

  startChecking() {
    if (typeof window === 'undefined') return;
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.checkSchedule(), 10000); // every 10s
    this.checkSchedule();
  }

  stopChecking() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private checkSchedule() {
    if (!this.store.isActive()) return;

    const now = new Date();
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentTimeStr = `${currentHours.toString().padStart(2, '0')}:${currentMinutes.toString().padStart(2, '0')}`;

    const schedule = this.store.schedule();
    const settings = this.store.settings();

    // Sort schedule by start time
    const todayClasses = schedule
      .filter(s => s.dayOfWeek === currentDay)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    for (let i = 0; i < todayClasses.length; i++) {
      const session = todayClasses[i];

      // Check start time (1 min before)
      const startParts = session.startTime.split(':');
      if (startParts.length === 2) {
        const startH = parseInt(startParts[0], 10);
        const startM = parseInt(startParts[1], 10);
        
        let notifyH = startH;
        let notifyM = startM - 1;
        if (notifyM < 0) {
          notifyM += 60;
          notifyH -= 1;
        }

        if (currentHours === notifyH && currentMinutes === notifyM) {
          const key = `start_${session.id}_${now.toDateString()}`;
          if (!this.notifiedSet.has(key)) {
            this.notifiedSet.add(key);
            
            const prevSession = i > 0 ? todayClasses[i-1] : null;
            const classNumber = i + 1;
            this.sendClassTransitionNotification(currentTimeStr, prevSession, session, classNumber, settings);
          }
        }
      }

      // Check end time
      if (settings.notifyEnd) {
        const endParts = session.endTime.split(':');
        if (endParts.length === 2) {
          const endH = parseInt(endParts[0], 10);
          const endM = parseInt(endParts[1], 10);

          if (currentHours === endH && currentMinutes === endM) {
            const key = `end_${session.id}_${now.toDateString()}`;
            if (!this.notifiedSet.has(key)) {
              this.notifiedSet.add(key);
              this.sendNotification('หมดคาบเรียน', `หมดคาบเรียนที่ ${i + 1} วิชา ${this.resolveName(session)} แล้ว`, 'end', settings);
            }
          }
        }
      }
    }
  }

  private resolveName(session: ClassSession): string {
    let mappings: Record<string, string> = {};
    try {
      const saved = localStorage.getItem('subject_mappings');
      if (saved) mappings = JSON.parse(saved);
    } catch {
      // Ignore if parsing or loading fails
    }
    return session.subjectName || mappings[session.subjectCode?.toUpperCase() || ''] || session.subjectCode || 'ไม่ระบุวิชา';
  }

  private sendClassTransitionNotification(time: string, prev: ClassSession | null, next: ClassSession, classNum: number, settings: AppSettings) {
    const nextName = this.resolveName(next);
    const prevName = prev ? this.resolveName(prev) : 'พักผ่อน/ก่อนเข้าเรียน';
    
    const prefix = classNum === 1 ? 'เริ่มเรียนคาบแรก' : `เริ่มเรียนคาบที่ ${classNum}`;
    
    let body = `ขณะนี้เวลา ${time} น. (${prefix})\nเปลี่ยนจาก ${prevName} → ${nextName}`;
    if (next.room) body += `\nเรียนห้อง: ${next.room}`;
    if (next.teacher) body += `\nคุณครู: ${next.teacher}`;

    this.sendNotification('เปลี่ยนคาบเรียน', body, 'start', settings);
  }

  sendTestNotification(settings: AppSettings) {
    this.sendNotification(
      'ทดสอบระบบแจ้งเตือน',
      `ขณะนี้เวลา ${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.\nนี่คือการทดสอบส่งการแจ้งเตือนจากระบบแอปตารางเรียนของคุณ`,
      'start',
      settings
    );
  }

  private sendNotification(title: string, body: string, type: 'start' | 'end', settings: AppSettings) {
    // 1. Play Sound
    this.playNotificationSound(settings.notificationSound);

    // 2. Set Visual In-app Popup
    this.store.activeNotification.set({
      title,
      body,
      type
    });

    // Auto-dismiss
    const durationMilli = (settings.popupDuration || 10) * 1000;
    setTimeout(() => {
      this.store.activeNotification.set(null);
    }, durationMilli);

    // 3. System Notification
    if (typeof window !== 'undefined') {
      if (Capacitor.isNativePlatform()) {
        LocalNotifications.schedule({
          notifications: [
            {
              title,
              body,
              id: Math.floor(Math.random() * 1000000),
              schedule: { at: new Date(Date.now() + 100) },
              sound: 'default'
            }
          ]
        }).catch(err => {
          console.warn('Failed to schedule native Local Notification:', err);
        });
      } else if ('Notification' in window && Notification.permission === 'granted') {
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.ready.then(registration => {
            const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
              body,
              icon: '/app-icon-192.png',
              badge: '/app-icon-192.png',
              tag: 'class-alert',
              renotify: true,
              vibrate: [200, 100, 200]
            };
            registration.showNotification(title, options);
          });
        } else {
          try {
            new Notification(title, {
              body,
              icon: '/app-icon-192.png'
            });
          } catch (err) {
            console.warn('Standard notification fallback failed', err);
          }
        }
      }
    }
  }

  public playNotificationSound(customSound?: string) {
    if (typeof window === 'undefined') return;
    if (customSound) {
      const audio = new Audio(customSound);
      audio.play().catch(e => console.warn('Failed to play custom sound', e));
      return;
    }
    try {
      const windowWithWebkit = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AudioContextClass = windowWithWebkit.AudioContext || windowWithWebkit.webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const t = ctx.currentTime;
      const freqs = [659, 988]; // E5, B5
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const s = t + i * 0.12;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, s);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.99, s + 0.8);
        gain.gain.setValueAtTime(0, s);
        gain.gain.linearRampToValueAtTime(0.18, s + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, s + 1.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(s);
        osc.stop(s + 1.3);
      });
    } catch (e) {
      console.warn('Failed to play notification sound', e);
    }
  }
}
