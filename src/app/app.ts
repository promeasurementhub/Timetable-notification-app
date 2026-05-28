import { ChangeDetectionStrategy, Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AppStore } from './store';
import { GeminiService } from './gemini';
import { NotificationService } from './notification';
import { ClassSession } from './models';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { environment } from '../environments/environment';

interface PwaInstallPrompt {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

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
  notificationPermission = signal<NotificationPermission | 'unsupported'>('default');

  activeTab = signal<'home' | 'schedule' | 'settings'>('home');
  isProcessing = signal(false);
  currentTime = signal<Date>(new Date());
  
  // Subject Mapping
  subjectMappings = signal<Record<string, string>>({});
  newMappingCode = signal('');
  newMappingName = signal('');
  userGeminiKey = signal('');
  githubRepo = signal('khaophan/Timetable-notification-app');
  deferredPrompt = signal<PwaInstallPrompt | null>(null);
  editingSession = signal<ClassSession | null>(null);
  updateAvailable = signal(false);
  isCheckingUpdate = signal(false);
  isInIframe = signal(typeof window !== 'undefined' && window.self !== window.top);

  editForm = new FormGroup({
    id: new FormControl('', { nonNullable: true }),
    subjectCode: new FormControl('', { nonNullable: true }),
    subjectName: new FormControl('', { nonNullable: true }),
    room: new FormControl('', { nonNullable: true }),
    teacher: new FormControl('', { nonNullable: true }),
    startTime: new FormControl('', { nonNullable: true, validators: Validators.pattern(/^([01]\d|2[0-3]):?([0-5]\d)$/) }),
    endTime: new FormControl('', { nonNullable: true, validators: Validators.pattern(/^([01]\d|2[0-3]):?([0-5]\d)$/) }),
    dayOfWeek: new FormControl('', { nonNullable: true })
  });

  apiKeySource = computed(() => {
    if (environment.GEMINI_API_KEY && environment.GEMINI_API_KEY !== 'REPLACE_ME_GEMINI_API_KEY') {
      return 'Baked-in (GitHub Secret)';
    }
    const local = this.userGeminiKey();
    if (local && local !== 'undefined') return 'Manual Override (Preferences)';
    return 'None (AI Studio Preview only)';
  });

  constructor() {
    if (typeof window !== 'undefined') {
      setInterval(() => {
        this.currentTime.set(new Date());
      }, 1000);

      const windowWithPwa = window as unknown as { deferredPrompt: PwaInstallPrompt | null | undefined };

      // Read existing deferredPrompt from window (captured by index.html)
      if (windowWithPwa.deferredPrompt) {
        this.deferredPrompt.set(windowWithPwa.deferredPrompt);
      }

      window.addEventListener('pwa-install-available', () => {
        if (windowWithPwa.deferredPrompt) {
          this.deferredPrompt.set(windowWithPwa.deferredPrompt);
        }
      });

      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        windowWithPwa.deferredPrompt = e as unknown as PwaInstallPrompt;
        this.deferredPrompt.set(e as unknown as PwaInstallPrompt);
      });

      window.addEventListener('appinstalled', () => {
        this.deferredPrompt.set(null);
        windowWithPwa.deferredPrompt = null;
      });
    }
  }

  async installPwa() {
    const promptEvent = this.deferredPrompt();
    if (promptEvent) {
      promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      console.log(`User response to the install prompt: ${outcome}`);
      this.deferredPrompt.set(null);
    }
  }

  private async getPref(key: string, fallback = ''): Promise<string> {
    if (Capacitor.isNativePlatform()) {
      const { value } = await Preferences.get({ key });
      return value || fallback;
    } else if (typeof window !== 'undefined') {
      return localStorage.getItem(key) || fallback;
    }
    return fallback;
  }

  private async setPref(key: string, value: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await Preferences.set({ key, value });
    } else if (typeof window !== 'undefined') {
      localStorage.setItem(key, value);
    }
  }

  async saveMapping() {
    const code = this.newMappingCode().trim().toUpperCase();
    const name = this.newMappingName().trim();
    if (!code || !name) return;

    const current = this.subjectMappings();
    const updated = { ...current, [code]: name };
    this.subjectMappings.set(updated);
    await this.setPref('subject_mappings', JSON.stringify(updated));
    
    // อัปเดตรายวิชาในตารางเรียนให้ใส่ชื่อวิชาอัตโนมัติจาก mapping ที่เพิ่งเข้ามา
    const currentSchedule = this.store.schedule();
    const newSchedule = currentSchedule.map(session => {
      const sessionCode = (session.subjectCode || '').trim().toUpperCase();
      if (sessionCode === code && !session.subjectName) {
         return { ...session, subjectName: name };
      }
      return session;
    });
    this.store.updateSchedule(newSchedule);
    
    this.newMappingCode.set('');
    this.newMappingName.set('');
  }

  async importMappings(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    
    const file = input.files[0];
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    
    const current = this.subjectMappings();
    const updated = { ...current };
    let importedCount = 0;
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      let matched = false;
      // Handle "Code > | Name"
      if (line.includes('> |')) {
        const [code, name] = line.split('> |');
        updated[code.trim().toUpperCase()] = name.trim();
        matched = true;
      }
      // Handle "Code | Name" or "Code = Name"
      else if (line.includes('|')) {
        const [code, name] = line.split('|');
        updated[code.trim().toUpperCase()] = name.trim();
        matched = true;
      } else if (line.includes('=')) {
        const [code, name] = line.split('=');
        updated[code.trim().toUpperCase()] = name.trim();
        matched = true;
      }
      // Handle "Code Name" occasionally separated by spaces if exact two parts, but let's just stick to explicit separators to avoid false positives.

      if (matched) {
        importedCount++;
      }
    }
    
    if (importedCount > 0) {
      this.subjectMappings.set(updated);
      await this.setPref('subject_mappings', JSON.stringify(updated));
      
      // อัปเดตรายวิชาในตารางเรียนให้ใส่ชื่อวิชาอัตโนมัติจาก mapping ที่เพิ่งเข้ามา
      const currentSchedule = this.store.schedule();
      const newSchedule = currentSchedule.map(session => {
        const code = (session.subjectCode || '').trim().toUpperCase();
        const mappedName = updated[code];
        // ถ้าคาบเรียนนี้มีรหัสตรงกับที่จับคู่ได้ และยังไม่มีชื่อวิชา ให้ใส่ลงไปเลย
        if (code && mappedName && !session.subjectName) {
           return { ...session, subjectName: mappedName };
        }
        return session;
      });
      
      this.store.updateSchedule(newSchedule);
      
      alert(`นำเข้าสำเร็จ ${importedCount} รายวิชา ระบบอัปเดตชื่อวิชาในตารางให้แล้ว`);
    } else {
      alert('ไม่พบข้อมูลรายวิชาในรูปแบบที่รองรับ (ตัวอย่างเช่น ว30103 = วิทยาศาสตร์ หรือ ว30103 > | วิทยาศาสตร์)');
    }
    
    // reset input
    input.value = '';
  }

  async saveGeminiKey() {
    const key = this.userGeminiKey().trim();
    await this.setPref('user_gemini_key', key);
    alert('บันทึก API Key เรียบร้อยแล้ว ระบบ AI พร้อมทำงาน');
  }

  async saveGithubRepo() {
    const repo = this.githubRepo().trim();
    if (!repo.includes('/')) {
      alert('รูปแบบชื่อ Repository ไม่ถูกต้อง (ต้องเป็น username/repo-name)');
      return;
    }
    await this.setPref('github_repo', repo);
    alert('บันทึกชื่อ Repository เรียบร้อยแล้ว');
  }

  async removeMapping(code: string) {
    const updated = { ...this.subjectMappings() };
    delete updated[code];
    this.subjectMappings.set(updated);
    await this.setPref('subject_mappings', JSON.stringify(updated));
  }

  resolveSubjectName(session: ClassSession): string {
    const code = (session.subjectCode || '').trim().toUpperCase();
    const mapping = this.subjectMappings();
    return mapping[code] || session.subjectName || code || 'ไม่ระบุวิชา';
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

  editSessionData(session: ClassSession) {
    this.editingSession.set(session);
    this.editForm.setValue({
      id: session.id,
      subjectCode: session.subjectCode || '',
      subjectName: session.subjectName || '',
      room: session.room || '',
      teacher: session.teacher || '',
      startTime: session.startTime || '',
      endTime: session.endTime || '',
      dayOfWeek: session.dayOfWeek || ''
    });
  }

  cancelEdit() {
    this.editingSession.set(null);
  }

  async saveEdit() {
    if (this.editForm.invalid) {
      alert('กรุณากรอกเวลาให้ถูกต้อง (HH:MM)');
      return;
    }
    const val = this.editForm.getRawValue();
    const currentSchedule = this.store.schedule();
    const updated = currentSchedule.map(s => s.id === val.id ? val : s);
    this.store.updateSchedule(updated);
    this.editingSession.set(null);
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

  isSchoolOutForToday = computed(() => {
    const todayList = this.currentDaySchedule();
    if (todayList.length === 0) return true;
    
    return todayList.every(session => this.getClassStatus(session) === 'past');
  });

  nextSchoolDayInfo = computed(() => {
    const list = this.store.schedule();
    if (list.length === 0) return null;

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const todayIdx = days.indexOf(todayStr);

    for (let i = 1; i <= 7; i++) {
      const checkIdx = (todayIdx + i) % 7;
      const checkStr = days[checkIdx];
      const classes = list.filter(c => c.dayOfWeek === checkStr).sort((a, b) => a.startTime.localeCompare(b.startTime));
      if (classes.length > 0) {
        return {
          day: checkStr,
          isTomorrow: i === 1,
          classes
        };
      }
    }
    return null;
  });

  async ngOnInit() {
    this.notification.startChecking();
    
    if (typeof window !== 'undefined') {
      if ('Notification' in window) {
        this.notificationPermission.set(Notification.permission);
        if (Notification.permission === 'default') {
          // Trigger the native Android / Browser prompt automatically on startup
          this.notification.requestPermission().then(() => {
            this.notificationPermission.set(Notification.permission);
          });
        }
      } else {
        this.notificationPermission.set('unsupported');
      }

      // Check Service Worker Updates
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg) {
            // Check if there is already a waiting worker
            if (reg.waiting) {
              this.updateAvailable.set(true);
            }

            // Periodically check/update on boot
            reg.update().catch(err => console.log('SW automatic update check failed:', err));

            // Notify when a new worker becomes available
            reg.addEventListener('updatefound', () => {
              const installingWorker = reg.installing;
              if (installingWorker) {
                installingWorker.addEventListener('statechange', () => {
                  if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    this.updateAvailable.set(true);
                  }
                });
              }
            });
          }
        });

        // Listen for controller taking over -> reload app instantly
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.location.reload();
        });
      }
    }

    // Load preferences async
    const [savedMappings, geminiKey, repo] = await Promise.all([
      this.getPref('subject_mappings'),
      this.getPref('user_gemini_key'),
      this.getPref('github_repo', 'khaophan/Timetable-notification-app')
    ]);

    if (savedMappings) {
      try {
        this.subjectMappings.set(JSON.parse(savedMappings));
      } catch (e) {
        console.error('Failed to load mappings', e);
      }
    }
    this.userGeminiKey.set(geminiKey);
    this.githubRepo.set(repo);
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
          
          // อัปเดตชื่อวิชาจาก mappings ที่มีอยู่แล้วอัตโนมัติ
          const mappings = this.subjectMappings();
          const mappedParsed = parsed.map((session: ClassSession) => {
            const code = (session.subjectCode || '').trim().toUpperCase();
            if (code && mappings[code] && !session.subjectName) {
              return { ...session, subjectName: mappings[code] };
            }
            return session;
          });
          
          this.store.updateSchedule(mappedParsed);
          this.setTab('home');
        } catch (err: unknown) {
          console.error(err);
          const errorMsg = err instanceof Error ? err.message : 'กรุณาลองใหม่อีกครั้ง';
          alert(`ไม่สามารถวิเคราะห์ตารางเรียนได้: ${errorMsg}`);
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

  updateSetting(key: string, value: string | number | boolean | undefined) {
    this.store.updateSettings({ [key]: value });
  }

  async requestNotificationPermission() {
    const granted = await this.notification.requestPermission();
    if (typeof window !== 'undefined' && 'Notification' in window) {
      this.notificationPermission.set(Notification.permission);
    }
    if (granted) {
      alert('อนุญาตการแจ้งเตือนเรียบร้อยแล้ว');
    } else {
      alert('การแจ้งเตือนถูกปฏิเสธ หากต้องการเปิดกรุณาตั้งค่าในเบราว์เซอร์');
    }
  }

  async testNotification() {
    if (this.notificationPermission() !== 'granted') {
      const granted = await this.notification.requestPermission();
      if (typeof window !== 'undefined' && 'Notification' in window) {
        this.notificationPermission.set(Notification.permission);
      }
      if (!granted) {
        alert('กรุณาอนุญาตการแจ้งเตือนก่อนทำการทดสอบ');
        return;
      }
    }
    this.notification.sendTestNotification(this.store.settings());
  }

  async checkForUpdates() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      alert('เบราว์เซอร์นี้ไม่รองรับระบบตรวจหาเวอร์ชัน');
      return;
    }

    this.isCheckingUpdate.set(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
        if (reg.waiting) {
          this.updateAvailable.set(true);
          alert('พบแอปเวอร์ชันใหม่ล่าสุดแล้ว! ระบบกำลังอัปเดต...');
        } else {
          // Soft check to verify
          await new Promise(resolve => setTimeout(resolve, 800));
          alert('ตารางเรียนของคุณเป็นเวอร์ชันล่าสุดแล้ว ✨ มั่นใจได้ ไม่จำเป็นต้องติดตั้งหรือโหลดใหม่!');
        }
      } else {
        alert('ไม่พบระบบช่วยบริการ Service Worker ของตารางเรียน กรุณารีโหลดหน้าเจอนี้อีกครั้ง');
      }
    } catch (e) {
      console.warn('Check update error:', e);
      alert('ไม่สามารถจัดส่งคำขอตรวจสอบอัปเดตได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง');
    } finally {
      this.isCheckingUpdate.set(false);
    }
  }

  applyUpdate() {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg && reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        } else {
          window.location.reload();
        }
      });
    }
  }
}

