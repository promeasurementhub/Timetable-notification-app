import { Injectable, inject, effect, signal } from '@angular/core';
import { AppStore } from './store';
import { ClassSession, AppSettings } from './models';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications, PendingResult } from '@capacitor/local-notifications';
import { Device, DeviceInfo } from '@capacitor/device';
import { uploadDiagnosticLogs } from './firebase-client';

export interface AuditEvent {
  id: string;
  timestamp: string;
  title: string;
  state: 'created' | 'scheduled' | 'delivered' | 'displayed' | 'clicked' | 'missed';
  details: string;
}

export interface SystemLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  category: 'system' | 'notification' | 'sync' | 'alarm';
  message: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private store = inject(AppStore);
  private notifiedSet = new Set<string>();
  private intervalId?: ReturnType<typeof setInterval>;
  
  // Observability layer
  logs = signal<SystemLog[]>([]);
  exactAlarmPermission = signal<'granted' | 'denied' | 'unknown'>('unknown');
  scheduledCount = signal<number>(0);
  pendingAlarms = signal<PendingResult | null>(null);
  
  // Reliability Metrics
  notificationsScheduled = signal<number>(0);
  notificationsFired = signal<number>(0);
  deviceInfo = signal<DeviceInfo | null>(null);
  
  auditLogs = signal<AuditEvent[]>([]);
  batteryOptimizationConfirmed = signal<boolean>(false);
  nextAlarm = signal<{title: string, time: Date, subjectName: string} | null>(null);
  lastCheckedTime = signal<Date | null>(null);
  scheduleIntegrityScore = signal<number>(100);
  sandboxSucceeded = signal<boolean>(false);
  
  constructor() {
    this.loadLogs();
    
    if (typeof window !== 'undefined') {
      this.checkNativeCapabilities();
      this.setupNativeListeners();
      
      // Check integrity on start and when returning to the app
      setTimeout(() => this.verifyAndHealSchedule(), 2000);
      document.addEventListener('visibilitychange', () => {
         if (document.visibilityState === 'visible') {
            this.verifyAndHealSchedule();
         }
      });

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

  private async setupNativeListeners() {
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.addListener('localNotificationReceived', (notification) => {
        this.notificationsFired.update(c => c + 1);
        this.saveMetrics();
        this.addLog('info', 'notification', `Alarm Fired: ${notification.title}`);
        this.addAudit(notification.id?.toString() || 'unknown', notification.title || 'Unknown', 'delivered', 'Android received the alarm and fired it');
      });
      
      LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        this.addLog('info', 'notification', `User interacted with alarm: ${action.actionId}`);
        this.addAudit(action.notification.id?.toString() || 'unknown', action.notification.title || 'Unknown', 'clicked', `Action: ${action.actionId}`);
        
        // Handle Sandbox Test Success
        if (action.notification.id === 777777) {
          this.sandboxSucceeded.set(true);
        }
      });
    }
  }

  // --- Observability (Logging) ---
  addAudit(id: string, title: string, state: AuditEvent['state'], details: string) {
    const timestamp = new Date().toISOString();
    const newAudit: AuditEvent = { id, timestamp, title, state, details };

    this.auditLogs.update(current => {
      const updated = [newAudit, ...current].slice(0, 500); // keep up to 500 audit logs
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('sched_audit_logs', JSON.stringify(updated));
      }
      return updated;
    });
  }

  exportLogsAsJson() {
    const data = {
      systemLogs: this.logs(),
      auditLogs: this.auditLogs(),
      deviceInfo: this.deviceInfo(),
      metrics: {
        scheduled: this.notificationsScheduled(),
        fired: this.notificationsFired()
      }
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagnostic_logs_${new Date().getTime()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  addLog(level: 'info' | 'warn' | 'error', category: 'system' | 'notification' | 'sync' | 'alarm', message: string) {
    const timestamp = new Date().toISOString();
    const newLog: SystemLog = { timestamp, level, category, message };
    
    this.logs.update(current => {
      const updated = [newLog, ...current].slice(0, 100); // Keep last 100 logs
      this.saveLogs(updated);
      return updated;
    });
    
    if (level === 'error') {
      console.error(`[${category}] ${message}`);
      // Push critical errors to Cloud
      uploadDiagnosticLogs([newLog]);
    } else if (level === 'warn') {
      console.warn(`[${category}] ${message}`);
    } else {
      console.log(`[${category}] ${message}`);
    }
  }

  private saveLogs(logsToSave: SystemLog[]) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sched_diagnostic_logs', JSON.stringify(logsToSave));
    }
  }

  private saveMetrics() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sched_metrics_fired', this.notificationsFired().toString());
      localStorage.setItem('sched_metrics_scheduled', this.notificationsScheduled().toString());
    }
  }

  private loadLogs() {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('sched_diagnostic_logs');
      if (saved) {
        try {
          this.logs.set(JSON.parse(saved));
        } catch {
          this.addLog('warn', 'system', 'Failed to parse previous logs. Starting fresh.');
        }
      }
      
      const savedFired = localStorage.getItem('sched_metrics_fired');
      const savedScheduled = localStorage.getItem('sched_metrics_scheduled');
      if (savedFired) this.notificationsFired.set(parseInt(savedFired, 10));
      if (savedScheduled) this.notificationsScheduled.set(parseInt(savedScheduled, 10));
      
      const savedAudits = localStorage.getItem('sched_audit_logs');
      if (savedAudits) {
        try {
          this.auditLogs.set(JSON.parse(savedAudits));
        } catch (err) {
          console.warn('Failed to parse saved audits:', err);
        }
      }
      
      const batteryConfirmed = localStorage.getItem('sched_battery_confirmed');
      if (batteryConfirmed === 'true') this.batteryOptimizationConfirmed.set(true);
    }
    this.addLog('info', 'system', 'Diagnostics service initialized.');
  }

  confirmBatteryOptimizationResolved() {
    this.batteryOptimizationConfirmed.set(true);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sched_battery_confirmed', 'true');
    }
    this.addLog('info', 'system', 'User confirmed battery optimization is resolved.');
  }

  private calculateNextOccurrence(weekday: number, hour: number, minute: number): Date {
    const now = new Date();
    // Capacitor weekdays: 1 = Sunday, 2 = Monday, ..., 7 = Saturday
    // JS Date.getDay(): 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const currentJsDay = now.getDay();
    const currentCapacitorDay = currentJsDay + 1;
    
    let daysToAdd = weekday - currentCapacitorDay;
    if (daysToAdd < 0 || (daysToAdd === 0 && (now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute)))) {
      daysToAdd += 7;
    }
    
    const nextDate = new Date(now);
    nextDate.setDate(now.getDate() + daysToAdd);
    nextDate.setHours(hour, minute, 0, 0);
    return nextDate;
  }

  async verifyAndHealSchedule() {
    this.lastCheckedTime.set(new Date());
    if (typeof window === 'undefined') return;
    
    const scheduleCount = this.store.schedule().length;
    if (Capacitor.isNativePlatform()) {
      try {
        const pending = await LocalNotifications.getPending();
        let closestAlarm: {title: string, time: Date, subjectName: string} | null = null;
        let closestDate = Infinity;
        
        pending.notifications.forEach(n => {
          let alarmTime: Date | null = null;
          if (n.schedule?.at) {
            alarmTime = new Date(n.schedule.at);
          } else if (n.schedule?.on) {
            alarmTime = this.calculateNextOccurrence(n.schedule.on.weekday!, n.schedule.on.hour!, n.schedule.on.minute!);
          }
          
          if (alarmTime && alarmTime.getTime() < closestDate) {
            closestDate = alarmTime.getTime();
            closestAlarm = {
              title: n.title || 'การแจ้งเตือน',
              time: alarmTime,
              subjectName: n.body || ''
            };
          }
        });
        
        this.nextAlarm.set(closestAlarm);
        
        // Auto heal logic
        // Only if app is active and schedule exists but pending alarms are zero
        if (this.store.isActive() && scheduleCount > 0 && pending.notifications.length === 0) {
           this.addLog('warn', 'system', 'Integrity issue detected: Schedule has items but OS has 0 alarms. Healing...');
           this.scheduleIntegrityScore.set(50);
           await this.scheduleAllNativeNotifications();
           this.scheduleIntegrityScore.set(100);
        } else {
           this.scheduleIntegrityScore.set(100);
        }
      } catch(e) {
        this.addLog('error', 'system', `Failed verify integrity: ${e}`);
      }
    }
  }

  async checkNativeCapabilities() {
    if (Capacitor.isNativePlatform()) {
       try {
         const info = await Device.getInfo();
         this.deviceInfo.set(info);
         this.addLog('info', 'system', `Device Info: ${info.manufacturer} ${info.model} (Android ${info.osVersion})`);
         
         if (['Xiaomi', 'OPPO', 'vivo', 'HUAWEI'].includes(info.manufacturer)) {
           this.addLog('warn', 'system', `Warning: ${info.manufacturer} devices often employ aggressive battery optimization which can delay alarms. Ensure app is excluded from battery optimization/doze mode.`);
         }

         const { display } = await LocalNotifications.checkPermissions();
         this.addLog('info', 'system', `LocalNotification permissions checked. Display: ${display}`);
         // Since Android 12 requires EXACT_ALARM for precise schedule, we assume true if not erroring. 
         this.exactAlarmPermission.set(display === 'granted' ? 'granted' : 'unknown');
         
         const pending = await LocalNotifications.getPending();
         this.pendingAlarms.set(pending);
         this.scheduledCount.set(pending.notifications.length);
         this.addLog('info', 'alarm', `Currently ${pending.notifications.length} native alarms pending in AlarmManager.`);
       } catch (err) {
         this.addLog('error', 'system', `Failed to check native capabilities: ${err}`);
       }
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
    
    // Check if we are running in browser and have FCM permission explicitly
    if (!Capacitor.isNativePlatform()) {
       console.log("Browser environment detected. Starting local schedule check interval.");
    }

    // เริ่มทำงานการเช็คเวลาทุกๆ 10 วินาที
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
        
        this.notificationsScheduled.update(c => c + 1);
        this.saveMetrics();
        this.addLog('info', 'alarm', `Successfully scheduled ${notificationsToSchedule.length} native alarms.`);
        
        // Refresh count
        this.checkNativeCapabilities();
      } else {
        this.addLog('info', 'alarm', 'No native alarms required by current schedule/settings.');
      }
    } catch (err) {
      this.addLog('error', 'alarm', `Failed to schedule native Local Notifications: ${err}`);
      console.warn('Failed to schedule native Local Notifications:', err);
    }
  }

  async scheduleSandboxNotification(seconds: number) {
    const title = '🎉 สำเร็จการทำงานเบื้องหลัง 100%';
    const body = `ระบบแจ้งเตือนทำงานสมบูรณ์แบบ! แม้คุณจะปัดปิดแอปไปแล้ว (${seconds} วินาทีที่แล้ว) ระบบ OS ของเครื่องยังปลุกแจ้งเตือนได้สำเร็จ`;

    if (Capacitor.isNativePlatform()) {
      try {
        await LocalNotifications.createChannel({
          id: 'class-alerts',
          name: 'แจ้งเตือนคาบเรียนด่วน',
          description: 'แสดงป้ายเตือนลอยด้านบนขอบจอ (Heads-up Alert)',
          importance: 5,
          sound: 'default',
          visibility: 1,
          vibration: true
        });

        // Cancel previous sandbox if any
        await LocalNotifications.cancel({ notifications: [{ id: 777777 }] }).catch((err) => {
          console.debug('No prior sandbox to cancel', err);
        });

        await LocalNotifications.schedule({
          notifications: [
            {
              title,
              body,
              id: 777777, // Specific ID for sandbox test
              schedule: { at: new Date(Date.now() + seconds * 1000), allowWhileIdle: true },
              sound: 'default',
              channelId: 'class-alerts'
            }
          ]
        });
        
        this.addLog('info', 'alarm', `Sandbox notification scheduled in ${seconds}s (ID: 777777). Now close app!`);
      } catch (err) {
        this.addLog('error', 'alarm', `Sandbox schedule error: ${err}`);
      }
    } else {
      // Web browser timeout fallback
      setTimeout(() => {
        if ('Notification' in window && Notification.permission === 'granted') {
          try {
            new Notification(title, { body });
          } catch {
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.ready.then(reg => reg.showNotification(title, { body }));
            }
          }
        }
      }, seconds * 1000);
    }
  }

  async cancelSandboxNotification() {
    if (Capacitor.isNativePlatform()) {
      try {
        await LocalNotifications.cancel({ notifications: [{ id: 777777 }] });
        this.addLog('info', 'alarm', `Sandbox test cancelled.`);
      } catch (err) {
        console.debug('No active sandbox to cancel', err);
      }
    }
  }
}
