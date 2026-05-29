import { Injectable, inject, effect } from '@angular/core';
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
      
      // Auto-schedule native alarms in OS whenever schedule or settings change
      effect(() => {
        // Trigger on any change of these signals
        this.store.schedule();
        this.store.settings();
        this.store.isActive();
        
        this.scheduleAllNativeNotifications();
      });
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

      // Check start time (preNotifyMinutes before)
      const preNotifyMinutes = settings.preNotifyMinutes !== undefined ? settings.preNotifyMinutes : 3;
      const startParts = session.startTime.split(':');
      if (startParts.length === 2) {
        const startH = parseInt(startParts[0], 10);
        const startM = parseInt(startParts[1], 10);
        
        let notifyH = startH;
        let notifyM = startM - preNotifyMinutes;
        while (notifyM < 0) {
          notifyM += 60;
          notifyH -= 1;
        }
        if (notifyH < 0) {
          notifyH = (notifyH % 24 + 24) % 24;
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
    const preNotifyMinutes = settings.preNotifyMinutes !== undefined ? settings.preNotifyMinutes : 3;
    
    const prefix = classNum === 1 ? 'คาบแรก' : `คาบที่ ${classNum}`;
    
    let body = preNotifyMinutes > 0
      ? `อีก ${preNotifyMinutes} นาทีจะเริ่มเรียน (${prefix})\nวิชา: ${nextName}\nเวลาเข้าเรียน: ${next.startTime} น.`
      : `ได้เวลาเริ่มเรียน (${prefix})\nวิชา: ${nextName}\nเวลาเข้าเรียน: ${next.startTime} น.`;
      
    if (next.room) body += `\nเรียนห้อง: ${next.room}`;
    if (next.teacher) body += `\nคุณครู: ${next.teacher}`;

    const title = preNotifyMinutes > 0
      ? `แจ้งเตือนเข้าเรียน (ล่วงหน้า ${preNotifyMinutes} นาที)`
      : 'แจ้งเตือนเริ่มชั้นเรียน';

    this.sendNotification(title, body, 'start', settings);
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
        LocalNotifications.createChannel({
          id: 'class-alerts',
          name: 'แจ้งเตือนคาบเรียนด่วน',
          description: 'แสดงป้ายเตือนลอยด้านบนขอบจอ (Heads-up Alert)',
          importance: 5,
          sound: 'default',
          visibility: 1,
          vibration: true
        }).then(() => {
          LocalNotifications.schedule({
            notifications: [
              {
                title,
                body,
                id: Math.floor(Math.random() * 1000000),
                schedule: { at: new Date(Date.now() + 100) },
                sound: 'default',
                channelId: 'class-alerts'
              }
            ]
          }).catch(err => {
            console.warn('Failed to schedule native Local Notification:', err);
          });
        }).catch(err => {
          console.warn('Failed to register notification channel:', err);
        });
      } else if ('Notification' in window && Notification.permission === 'granted') {
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.ready.then(registration => {
            const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
            const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
              body,
              icon: baseUrl + '/app-icon-192.png',
              badge: baseUrl + '/app-icon-192.png',
              tag: 'class-alert',
              renotify: true,
              vibrate: [200, 100, 200]
            };
            registration.showNotification(title, options);
          });
        } else {
          try {
            const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
            new Notification(title, {
              body,
              icon: baseUrl + '/app-icon-192.png'
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

  private stringToHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  async scheduleAllNativeNotifications() {
    if (!Capacitor.isNativePlatform()) return;

    try {
      // Create high-importance channel first so notifications show as heads-up banners on Android
      await LocalNotifications.createChannel({
        id: 'class-alerts',
        name: 'แจ้งเตือนคาบเรียนด่วน',
        description: 'แสดงป้ายเตือนลอยด้านบนขอบจอ (Heads-up Alert)',
        importance: 5,
        sound: 'default',
        visibility: 1,
        vibration: true
      });

      const pendingRes = await LocalNotifications.getPending();
      if (pendingRes?.notifications?.length > 0) {
        await LocalNotifications.cancel({
          notifications: pendingRes.notifications.map((n: { id: number }) => ({ id: n.id }))
        });
      }

      const schedule = this.store.schedule();
      const settings = this.store.settings();
      const isActive = this.store.isActive();

      if (!isActive) return;

      const notificationsToSchedule = [];

      const dayMap: Record<string, number> = {
        'sunday': 1,
        'monday': 2,
        'tuesday': 3,
        'wednesday': 4,
        'thursday': 5,
        'friday': 6,
        'saturday': 7
      };

      for (const session of schedule) {
        if (!session.dayOfWeek) continue;
        const normalizedDay = session.dayOfWeek.trim().toLowerCase();
        const weekday = dayMap[normalizedDay];
        if (!weekday) continue;

        // A. Start Time notify (preNotifyMinutes before)
        const preNotifyMinutes = settings.preNotifyMinutes !== undefined ? settings.preNotifyMinutes : 3;
        const startParts = session.startTime.split(':');
        if (startParts.length === 2) {
          const startH = parseInt(startParts[0], 10);
          const startM = parseInt(startParts[1], 10);
          
          let notifyH = startH;
          let notifyM = startM - preNotifyMinutes;
          let notifyWeekday = weekday;

          while (notifyM < 0) {
            notifyM += 60;
            notifyH -= 1;
          }
          if (notifyH < 0) {
            const daysToSubtract = Math.ceil(Math.abs(notifyH) / 24);
            notifyH = (notifyH % 24 + 24) % 24;
            notifyWeekday = weekday - daysToSubtract;
            while (notifyWeekday < 1) {
              notifyWeekday += 7;
            }
          }

          const subjectName = this.resolveName(session);
          let body = preNotifyMinutes > 0
            ? `อีก ${preNotifyMinutes} นาทีจะเริ่มเรียน\nวิชา: ${subjectName}\nเวลา: ${session.startTime} น.`
            : `ได้เวลาเริ่มเรียน\nวิชา: ${subjectName}\nเวลา: ${session.startTime} น.`;
            
          if (session.room) body += `\nเรียนห้อง: ${session.room}`;
          if (session.teacher) body += `\nคุณครู: ${session.teacher}`;

          const title = preNotifyMinutes > 0
            ? `แจ้งเตือนเข้าเรียน (ล่วงหน้า ${preNotifyMinutes} นาที)`
            : 'แจ้งเตือนเริ่มชั้นเรียน';

          notificationsToSchedule.push({
            id: this.stringToHash(session.id + '_start'),
            title: title,
            body: body,
            schedule: {
              on: {
                weekday: notifyWeekday,
                hour: notifyH,
                minute: notifyM
              },
              repeats: true,
              allowWhileIdle: true
            },
            sound: 'default',
            channelId: 'class-alerts'
          });
        }

        // B. End Time notify (at end time)
        if (settings.notifyEnd) {
          const endParts = session.endTime.split(':');
          if (endParts.length === 2) {
            const endH = parseInt(endParts[0], 10);
            const endM = parseInt(endParts[1], 10);

            const subjectName = this.resolveName(session);
            const body = `หมดคาบเรียนวิชา ${subjectName} แล้ว`;

            notificationsToSchedule.push({
              id: this.stringToHash(session.id + '_end'),
              title: 'หมดคาบเรียน',
              body: body,
              schedule: {
                on: {
                  weekday: weekday,
                  hour: endH,
                  minute: endM
                },
                repeats: true,
                allowWhileIdle: true
              },
              sound: 'default',
              channelId: 'class-alerts'
            });
          }
        }
      }

      if (notificationsToSchedule.length > 0) {
        await LocalNotifications.schedule({
          notifications: notificationsToSchedule
        });
        console.log(`Successfully scheduled ${notificationsToSchedule.length} native weekly alarms!`);
      }
    } catch (err) {
      console.warn('Failed to schedule native Local Notifications:', err);
    }
  }
}
