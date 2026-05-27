import { Injectable, inject } from '@angular/core';
import { AppStore } from './store';
import { ClassSession, AppSettings } from './models';

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
    if (typeof window !== 'undefined' && 'Notification' in window) {
      import('./firebase-client').then(({ requestFirebaseNotificationPermission }) => {
        requestFirebaseNotificationPermission().then(token => {
          if (token) {
            console.log('Firebase Push Notifications Enabled');
            localStorage.setItem('fcm_token_granted', 'true');
          }
        });
      }).catch(err => console.warn('Failed to load firebase client:', err));
    }
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

    const schedule = this.store.schedule();
    const settings = this.store.settings();

    for (const session of schedule) {
      if (session.dayOfWeek !== currentDay) continue;

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
            this.sendNotification('Upcoming Class', session, settings);
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
              this.sendNotification('Class Ended', session, settings, true);
            }
          }
        }
      }
    }
  }

  private sendNotification(title: string, session: ClassSession, settings: AppSettings, isEnd = false) {
    const thaiTitle = isEnd ? 'หมดคาบเรียน' : 'คาบเรียนถัดไป';
    let body = '';

    // Get mappings to resolve names
    let mappings: Record<string, string> = {};
    try {
      const saved = localStorage.getItem('subject_mappings');
      if (saved) mappings = JSON.parse(saved);
    } catch(e) {}

    const resolvedName = session.subjectName || mappings[session.subjectCode?.toUpperCase() || ''] || session.subjectCode;
    
    if (isEnd) {
      body = `หมดคาบเรียนวิชา ${resolvedName || 'ไม่ระบุ'} แล้ว`;
    } else {
      const parts = [];
      const showName = settings.notifySubjectName && resolvedName;
      const showCode = settings.notifySubjectCode && session.subjectCode && session.subjectCode !== resolvedName;
      
      let nameStr = '';
      if (showName) nameStr += resolvedName;
      if (showCode) nameStr += (showName ? ` (${session.subjectCode})` : session.subjectCode);
      
      if (nameStr) parts.push(nameStr);
      if (settings.notifyRoom && session.room) parts.push(`ห้อง: ${session.room}`);
      if (settings.notifyTeacher && session.teacher) parts.push(`ครู: ${session.teacher}`);
      
      body = parts.length > 0 ? parts.join('\n') : 'ไม่มีข้อมูลรายละเอียดวิชา';
    }

    // 1. Play Sound
    this.playNotificationSound(settings.notificationSound);

    // 2. Set Visual In-app Popup
    this.store.activeNotification.set({
      title: thaiTitle,
      body,
      type: isEnd ? 'end' : 'start'
    });

    // Auto-dismiss in-app popup after user-defined duration
    const durationMilli = (settings.popupDuration || 10) * 1000;
    setTimeout(() => {
      this.store.activeNotification.set(null);
    }, durationMilli);

    // 3. System Notification (if permitted)
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(thaiTitle, {
        body,
        icon: '/favicon.ico'
      });
    }
  }

  public playNotificationSound(customSound?: string) {
    if (typeof window === 'undefined') return;
    if (customSound) {
      const audio = new Audio(customSound);
      audio.play().catch(e => console.warn('Failed', e));
      return;
    }
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
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
