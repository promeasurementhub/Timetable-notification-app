import { ChangeDetectionStrategy, Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AppStore } from './store';
import { GeminiService } from './gemini';
import { NotificationService } from './notification';
import { ClassSession } from './models';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { environment } from '../environments/environment';

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
  
  // Subject Mapping
  subjectMappings = signal<Record<string, string>>({});
  newMappingCode = signal('');
  newMappingName = signal('');
  userGeminiKey = signal('');
  githubRepo = signal('khaophan/Timetable-notification-app');
  apiKeySource = computed(() => {
    if (environment.GEMINI_API_KEY && environment.GEMINI_API_KEY !== 'REPLACE_ME_GEMINI_API_KEY') {
      return 'Baked-in (GitHub Secret)';
    }
    const local = typeof window !== 'undefined' ? localStorage.getItem('user_gemini_key') : null;
    if (local && local !== 'undefined') return 'Manual Override (LocalStorage)';
    return 'None (AI Studio Preview only)';
  });

  // Update System States
  showUpdateModal = signal(false);
  updateProgress = signal(0);
  isUpdating = signal(false);
  updateVersion = signal('');
  updateStatus = signal<'idle' | 'checking' | 'downloading' | 'error'>('idle');
  currentAppHash = signal('Unknown');

  constructor() {
    if (typeof window !== 'undefined') {
      const savedMappings = localStorage.getItem('subject_mappings');
      if (savedMappings) {
        try {
          this.subjectMappings.set(JSON.parse(savedMappings));
        } catch (e) {
          console.error('Failed to load mappings', e);
        }
      }

      this.userGeminiKey.set(localStorage.getItem('user_gemini_key') || '');
      this.currentAppHash.set(localStorage.getItem('app_version')?.substring(0, 7) || 'Unknown');
      this.githubRepo.set(localStorage.getItem('github_repo') || 'khaophan/Timetable-notification-app');

      setInterval(() => {
        this.currentTime.set(new Date());
      }, 1000);
    }
  }

  saveMapping() {
    const code = this.newMappingCode().trim().toUpperCase();
    const name = this.newMappingName().trim();
    if (!code || !name) return;

    const current = this.subjectMappings();
    const updated = { ...current, [code]: name };
    this.subjectMappings.set(updated);
    localStorage.setItem('subject_mappings', JSON.stringify(updated));
    
    this.newMappingCode.set('');
    this.newMappingName.set('');
  }

  saveGeminiKey() {
    const key = this.userGeminiKey().trim();
    localStorage.setItem('user_gemini_key', key);
    alert('บันทึก API Key เรียบร้อยแล้ว ระบบ AI พร้อมทำงาน');
  }

  saveGithubRepo() {
    const repo = this.githubRepo().trim();
    if (!repo.includes('/')) {
      alert('รูปแบบชื่อ Repository ไม่ถูกต้อง (ต้องเป็น username/repo-name)');
      return;
    }
    localStorage.setItem('github_repo', repo);
    alert('บันทึกชื่อ Repository เรียบร้อยแล้ว');
  }

  removeMapping(code: string) {
    const current = this.subjectMappings();
    const { [code]: _, ...updated } = current;
    this.subjectMappings.set(updated);
    localStorage.setItem('subject_mappings', JSON.stringify(updated));
  }

  resolveSubjectName(session: ClassSession): string {
    const code = (session.subjectCode || '').toUpperCase();
    const mapping = this.subjectMappings();
    return session.subjectName || mapping[code] || code || 'ไม่ระบุวิชา';
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
        
        // ตรวจสอบเวอร์ชันล่าสุดหลังเปิดแอป 2 วินาที
        setTimeout(() => this.checkForUpdatesBackground(), 2000);
        
        // ตรวจสอบซ้ำทุก 30 นาที
        setInterval(() => this.checkForUpdatesBackground(), 30 * 60 * 1000);

        // ฟังการดาวน์โหลดเพื่อดึงเปอร์เซ็นต์จริง
        CapacitorUpdater.addListener('download', (info: any) => {
          if (info.percent) {
            this.updateProgress.set(Math.round(info.percent));
          }
        });
      } catch (e) {
        console.warn('OTA Init Error:', e);
      }
    }
  }

  async checkForUpdatesBackground() {
    if (this.isUpdating()) return;
    this.updateStatus.set('checking');
    
    try {
      const repo = this.githubRepo();
      const url = `https://github.com/${repo}/releases/download/ota-latest/version.json?t=${Date.now()}`;
      console.log('Background checking OTA from:', url);
      const response = await fetch(url, { cache: 'no-store' }).catch(() => null);
      
      if (response && response.ok) {
        const remote = await response.json();
        const localVersion = localStorage.getItem('app_version');
        
        if (remote.version !== localVersion) {
          this.updateVersion.set(remote.short_hash || remote.version.substring(0, 7));
          this.showUpdateModal.set(true);
        }
        this.updateStatus.set('idle');
      } else {
        this.updateStatus.set('error');
      }
    } catch (e) {
      this.updateStatus.set('error');
    }
  }

  async startLiveUpdate() {
    if (this.isUpdating()) return;
    
    this.isUpdating.set(true);
    this.updateStatus.set('downloading');
    this.updateProgress.set(0);
    
    try {
      // Safety Reset
      try { await CapacitorUpdater.reset(); } catch(e) {}

      const repo = this.githubRepo();
      const versionUrl = `https://github.com/${repo}/releases/download/ota-latest/version.json?t=${Date.now()}`;
      const versionResult = await fetch(versionUrl, { cache: 'no-store' });
      
      if (!versionResult.ok) {
        throw new Error(`Server responded with ${versionResult.status}: ${versionResult.statusText}`);
      }
      
      const remote = await versionResult.json();

      // Start download
      const update = await CapacitorUpdater.download({
        url: `https://github.com/${repo}/releases/download/ota-latest/update.zip?t=${Date.now()}`,
        version: remote.version
      });

      localStorage.setItem('app_version', remote.version);
      this.currentAppHash.set(remote.short_hash || remote.version.substring(0, 7));
      
      // Delay slightly for UI to show 100%
      await new Promise(r => setTimeout(r, 500));
      
      await CapacitorUpdater.set(update);
    } catch (e: any) {
      alert(`การอัปเดตล้มเหลว: ${e.message || 'Unknown Error'}\n\nกรุณาตรวจสอบอินเทอร์เน็ตและชื่อ Repository`);
      this.isUpdating.set(false);
      this.showUpdateModal.set(false);
      this.updateStatus.set('error');
    }
  }

  async checkUpdateManually() {
    if (this.updateStatus() === 'checking' || this.isUpdating()) return;
    this.updateStatus.set('checking');
    
    try {
      if (typeof window !== 'undefined' && (window as any).Capacitor) {
        const repo = this.githubRepo();
        const url = `https://github.com/${repo}/releases/download/ota-latest/version.json?t=${Date.now()}`;
        
        try {
          const response = await fetch(url, { cache: 'no-store' });
          if (response.ok) {
            const remote = await response.json();
            const localVersion = localStorage.getItem('app_version');
            
            if (remote.version !== localVersion) {
              this.updateVersion.set(remote.short_hash || remote.version.substring(0, 7));
              this.showUpdateModal.set(true);
            } else {
              alert('คุณกำลังใช้งานเวอร์ชันล่าสุดแล้ว (' + (remote.short_hash || 'Latest') + ')');
            }
            this.updateStatus.set('idle');
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } catch (e: any) {
          alert(`ไม่สามารถเชื่อมต่อ GitHub ได้ (${e.message})\n\nคำแนะนำ:\n1. ชื่อ Repo ต้องถูกต้อง (username/repo)\n2. สาเหตุส่วนใหญ่คือ GitHub ยังไม่สร้าง Release ให้เสร็จสิ้น (รอ 1-2 นาทีหลัง Push)`);
          this.updateStatus.set('error');
        }
      } else {
        alert('ฟีเจอร์นี้ใช้งานได้บนแอปพลิเคชันมือถือเท่านั้น');
        this.updateStatus.set('idle');
      }
    } catch (e) {
      this.updateStatus.set('error');
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

