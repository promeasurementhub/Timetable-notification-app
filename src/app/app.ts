import { ChangeDetectionStrategy, Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AppStore } from './store';
import { GeminiService } from './gemini';
import { NotificationService } from './notification';
import { ClassSession } from './models';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [CommonModule, FormsModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  store = inject(AppStore);
  gemini = inject(GeminiService);
  notification = inject(NotificationService);

  activeTab = signal<'home' | 'schedule' | 'settings'>('home');
  isProcessing = signal(false);
  currentTime = signal<Date>(new Date());

  constructor() {
    if (typeof window !== 'undefined') {
      setInterval(() => {
        this.currentTime.set(new Date());
      }, 1000);
    }
  }

  getClassStatus(session: ClassSession): 'past' | 'current' | 'future' {
    const now = this.currentTime();
    const [startH, startM] = session.startTime.split(':').map(Number);
    const [endH, endM] = session.endTime.split(':').map(Number);
    
    const startTime = new Date(now);
    startTime.setHours(startH, startM, 0, 0);
    
    const endTime = new Date(now);
    endTime.setHours(endH, endM, 0, 0);

    if (now > endTime) return 'past';
    if (now >= startTime && now <= endTime) return 'current';
    return 'future';
  }

  getCountdown(session: ClassSession): string {
    const now = this.currentTime();
    const [endH, endM] = session.endTime.split(':').map(Number);
    const endTime = new Date(now);
    endTime.setHours(endH, endM, 0, 0);
    
    const diff = endTime.getTime() - now.getTime();
    if (diff <= 0) return '00:00';
    
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  // Group schedule by day
  groupedSchedule = computed(() => {
    const list = this.store.schedule();
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const result: { day: string; classes: ClassSession[] }[] = [];
    
    for (const day of days) {
      const classes = list.filter(c => c.dayOfWeek === day).sort((a, b) => a.startTime.localeCompare(b.startTime));
      if (classes.length > 0) result.push({ day, classes });
    }
    return result;
  });

  currentDaySchedule = computed(() => {
    const list = this.store.schedule();
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    return list.filter(c => c.dayOfWeek === today).sort((a, b) => a.startTime.localeCompare(b.startTime));
  });

  async ngOnInit() {
    this.notification.startChecking();
    
    // OTA Update Check
    if (typeof window !== 'undefined' && (window as any).Capacitor) {
      try {
        await CapacitorUpdater.notifyAppReady();
        
        // ค้นหาชื่อ Repo จาก URL ของแอป (กรณีอยู่ใน AI Studio) 
        // หรือกำหนดเองถ้าทราบชื่อแน่นอน
        const repo = "khaophan/Timetable-notification-app";
        
        // ตรวจสอบเวอร์ชันล่าสุดจาก GitHub Releases
        // หมายเหตุ: ในแอปจริงควรมีหน้า Loading หรือทำใน Background
        const response = await fetch(`https://raw.githubusercontent.com/${repo}/main/version.json`).catch(() => null);
        if (response && response.ok) {
          const remote = await response.json();
          const localVersion = localStorage.getItem('app_version');
          
          if (remote.version !== localVersion) {
            console.log('New version found! Downloading...');
            const update = await CapacitorUpdater.download({
              url: `https://github.com/${repo}/releases/download/ota-latest/update.zip`,
              version: remote.version
            });
            
            await CapacitorUpdater.set(update);
            localStorage.setItem('app_version', remote.version);
            // แอปจะรีโหลดอัตโนมัติ
          }
        }
      } catch (e) {
        console.warn('OTA Error:', e);
      }
    }
  }

  setTab(tab: 'home' | 'schedule' | 'settings') {
    this.activeTab.set(tab);
  }

  toggleActive() {
    this.store.toggleActive(!this.store.isActive());
  }

  translateDay(day: string): string {
    const map: Record<string, string> = {
      'Monday': 'วันจันทร์',
      'Tuesday': 'วันอังคาร',
      'Wednesday': 'วันพุธ',
      'Thursday': 'วันพฤหัสบดี',
      'Friday': 'วันศุกร์',
      'Saturday': 'วันเสาร์',
      'Sunday': 'วันอาทิตย์'
    };
    return map[day] || day;
  }

  clearSchedule() {
    if (confirm('คุณต้องการลบข้อมูลตารางเรียนทั้งหมดใช่หรือไม่?')) {
      this.store.updateSchedule([]);
    }
  }

  updateDuration(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value);
    this.store.updateSettings({ popupDuration: value });
  }

  onSoundSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target?.result as string;
        this.store.updateSettings({ notificationSound: base64 });
      };
      reader.readAsDataURL(file);
    }
  }

  testSound() {
    this.notification.playNotificationSound(this.store.settings().notificationSound);
  }

  async onFileSelected(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    this.isProcessing.set(true);
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        try {
          const parsed = await this.gemini.parseScheduleImage(base64, file.type);
          this.store.updateSchedule(parsed);
          this.setTab('home');
        } catch (err) {
          console.error(err);
          alert('ไม่สามารถวิเคราะห์ตารางเรียนได้ กรุณาลองใหม่อีกครั้ง');
        } finally {
          this.isProcessing.set(false);
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      this.isProcessing.set(false);
    }
  }

  updateSetting(key: string, value: any) {
    this.store.updateSettings({ [key]: value });
  }
}

