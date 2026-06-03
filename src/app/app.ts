import { ChangeDetectionStrategy, Component, inject, OnInit, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormGroup, FormControl, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AppStore } from './store';
import { GeminiService } from './gemini';
import { NotificationService } from './notification';
import { ClassSession, AppSettings } from './models';
import { CalendarDay, CalendarMonth, THAI_MONTHS, PUBLIC_HOLIDAYS_2026 } from './calendar';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { LocalNotifications } from '@capacitor/local-notifications';
import { environment } from '../environments/environment';
import { auth, ADMIN_EMAIL, GlobalConfig } from './firebase-client';
import { onAuthStateChanged, User } from 'firebase/auth';

interface BackupData {
  schedule?: ClassSession[];
  settings?: AppSettings;
  active?: boolean;
}

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
  notificationPermission = signal<string>('default');

  activeTab = signal<'home' | 'schedule' | 'calendar' | 'settings' | 'debug' | 'admin'>('home');
  isProcessing = signal(false);
  currentTime = signal<Date>(new Date());

  // Admin Signals
  adminBackendApiUrl = signal('');
  adminBroadcastText = signal('');
  adminMaintenanceMode = signal(false);
  adminGithubRepo = signal('khaophan/Timetable-notification-app');
  adminSubjectMappings = signal<Record<string, string>>({});
  
  newAdminMappingCode = signal('');
  newAdminMappingName = signal('');

  // Authentication Signals
  adminUser = signal<User | null>(null);
  isAdminLoggedIn = computed(() => {
    const user = this.adminUser();
    return user && user.email === ADMIN_EMAIL;
  });

  
  readinessScore = computed(() => {
    let score = 100;
    
    if (this.notificationPermission() !== 'granted') score -= 40;
    
    if (this.isNativePlatform()) {
      if (this.notification.exactAlarmPermission() !== 'granted') score -= 40;
      
      const m = this.notification.deviceInfo()?.manufacturer;
      if (['Xiaomi', 'OPPO', 'vivo', 'HUAWEI'].includes(m || '') && !this.notification.batteryOptimizationConfirmed()) {
        score -= 20;
      }
    }
    
    return Math.max(0, score);
  });
  
  // Subject Mapping
  subjectMappings = signal<Record<string, string>>({});
  newMappingCode = signal('');
  newMappingName = signal('');
  userGeminiKey = signal('');
  backendApiUrl = signal('');
  githubRepo = signal('khaophan/Timetable-notification-app');
  deferredPrompt = signal<PwaInstallPrompt | null>(null);
  editingSession = signal<ClassSession | null>(null);
  updateAvailable = signal(false);
  isCheckingUpdate = signal(false);
  appKillSandboxCountdown = signal<number>(0);
  appKillSandboxActive = signal<boolean>(false);
  appKillSandboxBrand = signal<string>('all');
  appKillSandboxTimerId: ReturnType<typeof setInterval> | null = null;
  isInIframe = signal(typeof window !== 'undefined' && window.self !== window.top);
  isInAppBrowser = signal(false);
  isStandalone = signal(typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (window.navigator as { standalone?: boolean }).standalone === true));
  isNativePlatform = signal(Capacitor.isNativePlatform());
  swStatus = signal<'checking' | 'registered' | 'failed' | 'not_supported'>('checking');
  showOnboarding = signal(false);
  showSandboxSuccessPopup = signal(false);
  
  preNotifyMinutes = computed(() => this.store.settings().preNotifyMinutes ?? 3);
  calendarMonths = computed(() => this.generateCalendar());
  selectedDate = signal<CalendarDay | null>(null);
  showHolidayEditor = signal(false);
  editingHolidayName = signal('');
  
  generateCalendar(): CalendarMonth[] {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();
    
    // Default public holidays for 2026/current year
    const publicHolidays = PUBLIC_HOLIDAYS_2026; 
    const customHolidays = this.store.settings().calendarHolidays || {};

    const months: CalendarMonth[] = [];
    
    for (let m = currentMonth; m < 12; m++) {
      const monthDays: CalendarDay[] = [];
      const firstDay = new Date(currentYear, m, 1);
      const lastDay = new Date(currentYear, m + 1, 0);
      
      // Calculate padding days to start on Sunday padding
      const padding = firstDay.getDay(); 
      for (let i = 0; i < padding; i++) {
        monthDays.push({
          date: new Date(currentYear, m, 1 - (padding - i)),
          dateString: '',
          isToday: false,
          isCurrentMonth: false,
          isWeekend: false
        });
      }
      
      for (let d = 1; d <= lastDay.getDate(); d++) {
        const date = new Date(currentYear, m, d);
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const dateString = `${yyyy}-${mm}-${dd}`;
        
        const isToday = 
          date.getDate() === today.getDate() && 
          date.getMonth() === today.getMonth() && 
          date.getFullYear() === today.getFullYear();
          
        const isWeekend = date.getDay() === 0 || date.getDay() === 6;
        const dayItem: CalendarDay = {
          date,
          dateString,
          isToday,
          isCurrentMonth: true,
          isWeekend
        };
        
        // Merge holidays
        const customName = customHolidays[dateString];
        const publicName = publicHolidays[dateString];
        
        if (customName) {
           dayItem.holidayName = customName;
           dayItem.isCustomHoliday = true;
        } else if (publicName) {
           dayItem.holidayName = publicName;
           dayItem.isCustomHoliday = false;
        } else if (isWeekend) {
           dayItem.holidayName = date.getDay() === 0 ? 'วันอาทิตย์' : 'วันเสาร์';
           dayItem.isCustomHoliday = true; // treat weekend as a rest day explicitly
        }

        monthDays.push(dayItem);
      }
      
      months.push({
        year: currentYear,
        month: m,
        name: THAI_MONTHS[m],
        days: monthDays
      });
    }
    return months;
  }
  
  openHolidayEditor(day: CalendarDay) {
    if (!day.isCurrentMonth) return;
    this.selectedDate.set(day);
    this.editingHolidayName.set(day.holidayName && day.holidayName !== 'วันเสาร์' && day.holidayName !== 'วันอาทิตย์' ? day.holidayName : '');
    this.showHolidayEditor.set(true);
  }
  
  saveHoliday() {
    const day = this.selectedDate();
    if (!day) return;
    
    // We only save to custom holidays
    const current = { ...(this.store.settings().calendarHolidays || {}) };
    const name = this.editingHolidayName().trim();
    if (name) {
      current[day.dateString] = name;
    } else {
      delete current[day.dateString];
    }
    this.store.updateSettings({ calendarHolidays: current });
    this.showHolidayEditor.set(false);
  }
  
  isSchoolHoliday(dateString: string): { isHoliday: boolean, name?: string } {
     const customHolidays = this.store.settings().calendarHolidays || {};
     
     if (customHolidays[dateString]) return { isHoliday: true, name: customHolidays[dateString] };
     if (PUBLIC_HOLIDAYS_2026[dateString]) return { isHoliday: true, name: PUBLIC_HOLIDAYS_2026[dateString] };
     
     const parts = dateString.split('-');
     if (parts.length === 3) {
       const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
       const dayOfWeek = date.getDay();
       if (dayOfWeek === 0) return { isHoliday: true, name: 'วันอาทิตย์' };
       if (dayOfWeek === 6) return { isHoliday: true, name: 'วันเสาร์' };
     }
     
     return { isHoliday: false };
  }

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
    // Watch for App Kill Test completion (via OS notification click)
    effect(() => {
      if (this.notification.sandboxSucceeded()) {
        this.showSandboxSuccessPopup.set(true);
        // Reset the signal for next test
        this.notification.sandboxSucceeded.set(false);
      }
    });

    effect(() => {
      const g = this.store.globalConfig();
      if (g) {
        this.adminBackendApiUrl.set(g.backendApiUrl || '');
        this.adminBroadcastText.set(g.broadcastText || '');
        this.adminMaintenanceMode.set(!!g.maintenanceMode);
        this.adminGithubRepo.set(g.githubRepo || 'khaophan/Timetable-notification-app');
        this.adminSubjectMappings.set(g.subjectMappings || {});
      }
    });

    if (typeof window !== 'undefined') {
      setInterval(() => {
        this.currentTime.set(new Date());
      }, 1000);

      // In-App browser detection (Line, FB, Messenger, IG, Webview)
      const ua = window.navigator.userAgent.toLowerCase();
      const isApp = ua.includes('line/') || ua.includes('fbav') || ua.includes('messenger') || ua.includes('fbios') || ua.includes('instagram') || ua.includes('webview') || ua.includes('wv');
      this.isInAppBrowser.set(isApp);

      // Service worker registration check
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg) {
            this.swStatus.set('registered');
          } else {
            this.swStatus.set('checking');
            navigator.serviceWorker.ready.then(() => {
              this.swStatus.set('registered');
            }).catch(() => {
              this.swStatus.set('failed');
            });
          }
        }).catch(() => {
          this.swStatus.set('failed');
        });
      } else {
        this.swStatus.set('not_supported');
      }

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

  async saveBackendApiUrl() {
    const url = this.backendApiUrl().trim();
    await this.setPref('backend_api_url', url);
    alert('บันทึกเซิร์ฟเวอร์หลังบ้านเรียบร้อยแล้ว');
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
    const name = mapping[code] || session.subjectName || code || '';
    
    // Check if it's the last session of the day
    const allSessionsToday = this.store.schedule().filter(s => s.dayOfWeek === session.dayOfWeek).sort((a, b) => a.startTime.localeCompare(b.startTime));
    const isLast = allSessionsToday.length > 0 && allSessionsToday[allSessionsToday.length - 1].id === session.id;

    if (isLast && (!name || name === 'โฮมรูม' || name === 'ว่าง')) {
       return 'เลิกเรียน';
    }
    
    return name || 'ไม่ระบุวิชา';
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

  getBellTime(session: ClassSession): string {
    const preNotifyMinutes = this.preNotifyMinutes();
    const [startH, startM] = session.startTime.split(':').map(Number);
    let notifyH = startH;
    let notifyM = startM - preNotifyMinutes;
    while (notifyM < 0) {
      notifyM += 60;
      notifyH -= 1;
    }
    if (notifyH < 0) {
      notifyH = (notifyH % 24 + 24) % 24;
    }
    return `${notifyH.toString().padStart(2, '0')}:${notifyM.toString().padStart(2, '0')}`;
  }

  getBellCountdown(session: ClassSession): string | null {
    const now = this.currentTime();
    
    // Calculate bell/notification target date for today
    const [startH, startM] = session.startTime.split(':').map(Number);
    const preNotifyMinutes = this.preNotifyMinutes();
    
    let notifyH = startH;
    let notifyM = startM - preNotifyMinutes;
    while (notifyM < 0) {
      notifyM += 60;
      notifyH -= 1;
    }
    if (notifyH < 0) {
      notifyH = (notifyH % 24 + 24) % 24;
    }
    
    const bellTime = new Date(now);
    bellTime.setHours(notifyH, notifyM, 0, 0);
    
    const diff = bellTime.getTime() - now.getTime();
    if (diff <= 0) return null; // Already passed
    
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
    
    // Validate end time must be after start time
    if (val.startTime && val.endTime && val.endTime <= val.startTime) {
       alert('เวลาเลิกเรียนต้องอยู่หลังเวลาเริ่มเรียน');
       return;
    }
    
    const currentSchedule = this.store.schedule();
    
    // Prevent overlapping times on same day
    const overlapping = currentSchedule.some(s => 
      s.id !== val.id && 
      s.dayOfWeek === val.dayOfWeek && 
      (
        (val.startTime >= s.startTime && val.startTime < s.endTime) ||
        (val.endTime > s.startTime && val.endTime <= s.endTime) ||
        (val.startTime <= s.startTime && val.endTime >= s.endTime)
      )
    );
    
    if (overlapping) {
       alert('เวลาเรียนที่แก้ไขทับซ้อนกับวิชาอื่นในวันเดียวกัน');
       return;
    }

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

  addSampleSchedule() {
    const todayStr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][this.currentTime().getDay()];
    // Set 2 fake classes: one 5 mins from now, one 2 hours from now
    const now = this.currentTime();
    const pad = (n: number) => n.toString().padStart(2, '0');
    
    const time1 = new Date(now.getTime() + 5 * 60000); // 5 mins from now
    const time1End = new Date(now.getTime() + 55 * 60000); // 50 mins class
    
    const time2 = new Date(now.getTime() + 60 * 60000); // 1 hour from now
    const time2End = new Date(now.getTime() + 110 * 60000); 

    const sample = [
      {
        id: 'sample_' + Date.now(),
        subjectName: 'วิทยาศาสตร์ (ตัวอย่าง)',
        subjectCode: 'SCI101',
        room: 'B401',
        teacher: 'อ.ใจดี',
        startTime: pad(time1.getHours()) + ':' + pad(time1.getMinutes()),
        endTime: pad(time1End.getHours()) + ':' + pad(time1End.getMinutes()),
        dayOfWeek: todayStr
      },
      {
        id: 'sample_' + Date.now() + 1,
        subjectName: 'คณิตศาสตร์ (ตัวอย่าง)',
        subjectCode: 'MATH101',
        room: 'A102',
        teacher: 'อ.สมใจ',
        startTime: pad(time2.getHours()) + ':' + pad(time2.getMinutes()),
        endTime: pad(time2End.getHours()) + ':' + pad(time2End.getMinutes()),
        dayOfWeek: todayStr
      }
    ];
    this.store.updateSchedule(sample);
    alert('สร้างตารางเรียนตัวอย่าง 2 วิชาสำหรับวันนี้เรียบร้อยแล้ว ลองทดสอบการทำงานได้เลย');
  }

  currentDaySchedule = computed(() => {
    const list = this.store.schedule();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today = this.currentTime();
    const todayStr = days[today.getDay()];
    return list.filter(c => c.dayOfWeek === todayStr).sort((a, b) => a.startTime.localeCompare(b.startTime));
  });

  isSchoolOutForToday = computed(() => {
    if (this.todayHolidayInfo().isHoliday) return true;
    const todayList = this.currentDaySchedule();
    if (todayList.length === 0) return true;
    
    return todayList.every(session => this.getClassStatus(session) === 'past');
  });

  tomorrowDaySchedule = computed(() => {
    const list = this.store.schedule();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const tomorrow = new Date(this.currentTime().getTime() + 86400000); // Add 24 hours
    const tomorrowStr = days[tomorrow.getDay()];
    return list.filter(c => c.dayOfWeek === tomorrowStr).sort((a, b) => a.startTime.localeCompare(b.startTime));
  });

  todaySmartSummary = computed(() => {
    const count = this.currentDaySchedule().length;
    if (this.todayHolidayInfo().isHoliday) return `วันนี้เป็นวันหยุด (${this.todayHolidayInfo().name}) พักผ่อนให้เต็มที่!`;
    if (count === 0) return 'วันนี้ไม่มีคาบเรียนในระบบ';
    
    // check if all past
    if (this.isSchoolOutForToday()) return 'วันนี้เรียนจบแล้ว เก่งมาก!';
    
    return `วันนี้มีเรียนทั้งหมด ${count} คาบ`;
  });

  tomorrowSmartSummary = computed(() => {
    const count = this.tomorrowDaySchedule().length;
    if (count === 0) return 'คุณยังไม่มีตารางเรียนสำหรับวันพรุ่งนี้';
    const firstClass = this.tomorrowDaySchedule()[0];
    return `พรุ่งนี้เริ่มต้นวันด้วยวิชา${firstClass.subjectName || ''} เวลา ${firstClass.startTime} น.`;
  });

  timeUntilNextAlarmText = computed(() => {
    const next = this.notification.nextAlarm();
    if (!next) return '';
    const now = this.currentTime().getTime();
    const target = next.time.getTime();
    const diffMs = target - now;
    if (diffMs <= 0) return 'กำลังถึงเวลา...';
    
    const diffMins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `อีก ${days} วัน ${hours % 24} ชั่วโมง`;
    }
    if (hours > 0) {
      return `อีก ${hours} ชั่วโมง ${mins} นาที`;
    }
    return `อีก ${mins} นาที`;
  });
  
  cloudBackupAvailable = signal<BackupData | null>(null);
  showRestorePrompt = signal(false);

  nextSchoolDayInfo = computed(() => {
    const list = this.store.schedule();
    if (list.length === 0) return null;

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today = this.currentTime();
    
    for (let i = 1; i <= 30; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() + i);
      
      const yyyy = checkDate.getFullYear();
      const mm = String(checkDate.getMonth() + 1).padStart(2, '0');
      const dd = String(checkDate.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      
      if (this.isSchoolHoliday(dateStr).isHoliday) {
         continue; // skip holidays
      }
      
      const checkStr = days[checkDate.getDay()];
      const classes = list.filter(c => c.dayOfWeek === checkStr).sort((a, b) => a.startTime.localeCompare(b.startTime));
      
      return {
        day: checkStr,
        isTomorrow: i === 1,
        classes
      };
    }
    return null;
  });

  todayHolidayInfo = computed(() => {
    const today = this.currentTime();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return this.isSchoolHoliday(`${yyyy}-${mm}-${dd}`);
  });

  tomorrowHolidayInfo = computed(() => {
    const today = this.currentTime();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const yyyy = tomorrow.getFullYear();
    const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const dd = String(tomorrow.getDate()).padStart(2, '0');
    return this.isSchoolHoliday(`${yyyy}-${mm}-${dd}`);
  });

  async ngOnInit() {
    this.notification.startChecking();
    this.checkCloudBackupOnBoot();

    onAuthStateChanged(auth, (user) => {
      this.adminUser.set(user);
    });
    
    await this.updateNotificationPermissionStatus();

    if (typeof window !== 'undefined') {
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
    const [savedMappings, geminiKey, repo, onboardingStatus, savedBackendUrl] = await Promise.all([
      this.getPref('subject_mappings'),
      this.getPref('user_gemini_key'),
      this.getPref('github_repo', 'khaophan/Timetable-notification-app'),
      this.getPref('has_seen_onboarding', 'false'),
      this.getPref('backend_api_url')
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

    let defaultApiUrl = '';
    if (typeof window !== 'undefined') {
      defaultApiUrl = window.location.origin;
    }
    if (Capacitor.isNativePlatform()) {
      defaultApiUrl = 'https://ais-pre-5ce7x4ii37m5xmqzzudf4v-123885007893.asia-southeast1.run.app';
    }
    const backendUrl = savedBackendUrl || defaultApiUrl;
    this.backendApiUrl.set(backendUrl);

    // Show onboarding if they are in Standalone/PWA mode and haven't seen it yet
    if (onboardingStatus === 'false' && typeof window !== 'undefined' && 'Notification' in window) {
       // Only show if it is not already granted or denied (meaning it's 'default')
       if (this.notificationPermission() === 'default') {
          this.showOnboarding.set(true);
       }
    }
  }

  async acceptOnboarding() {
    this.showOnboarding.set(false);
    await this.setPref('has_seen_onboarding', 'true');
    await this.requestNotificationPermission();
  }

  async declineOnboarding() {
    this.showOnboarding.set(false);
    await this.setPref('has_seen_onboarding', 'true');
  }

  setTab(tab: 'home' | 'schedule' | 'settings' | 'calendar' | 'debug' | 'admin') {
    this.activeTab.set(tab);
  }

  toggleActive() {
    this.store.toggleActive(!this.store.isActive());
  }

  showResetConfirm = signal(false);

  confirmReset() {
    this.showResetConfirm.set(true);
  }

  async executeReset() {
    await this.store.resetAll();
    this.showResetConfirm.set(false);
    this.setTab('home');
  }

  cancelReset() {
    this.showResetConfirm.set(false);
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

  async updateNotificationPermissionStatus() {
    if (typeof window !== 'undefined') {
      if (Capacitor.isNativePlatform()) {
        try {
          const { display } = await LocalNotifications.checkPermissions();
          this.notificationPermission.set(display);
        } catch (err) {
          console.error('Error checking native permissions:', err);
          this.notificationPermission.set('default');
        }
      } else if ('Notification' in window) {
        this.notificationPermission.set(Notification.permission);
      } else {
        this.notificationPermission.set('unsupported');
      }
    }
  }

  async requestNotificationPermission() {
    this.isProcessing.set(true);
    try {
      const granted = await this.notification.requestPermission();
      await this.updateNotificationPermissionStatus();
      
      if (granted || this.notificationPermission() === 'granted') {
        this.store.activeNotification.set({
          title: 'สำเร็จ!',
          body: 'อนุญาตการแจ้งเตือนสิทธิ์เรียบร้อยแล้ว ระบบตารางเรียนจะแจ้งเตือนเมื่อเริ่มคาบเรียน',
          type: 'start'
        });
      } else {
        this.store.activeNotification.set({
          title: 'สิทธิ์ถูกปฏิเสธ',
          body: 'การแจ้งเตือนถูกบล็อก กรุณาตั้งค่าคู่มืออนุญาตทำงานเบื้องหลังหรือตรวจสอบความช่วยเหลือ',
          type: 'end'
        });
      }
    } catch (err) {
      console.error('Error requesting notification permission:', err);
    } finally {
      this.isProcessing.set(false);
    }
  }

  handleDeniedPermissionClick() {
    this.appKillSandboxActive.set(true);
    this.appKillSandboxBrand.set('samsung'); // Opens the "คู่มืออนุญาตเบื้องหลังรายรุ่น"
    
    this.store.activeNotification.set({
      title: 'สิทธิ์ถูกบล็อก/ระงับ',
      body: 'โปรดตั้งค่าอนุญาตแจ้งเตือนในการตั้งค่าตัวเครื่อง (App Info) พร้อมปลดขีดจำกัดแบตเตอรี่เบื้องหลัง',
      type: 'end'
    });
  }

  hasDisplayableHistory(logs: { state: string }[]) {
    return logs.some(l => l.state === 'delivered' || l.state === 'missed');
  }
  
  dismissRestore() {
    this.showRestorePrompt.set(false);
  }
  
  async checkCloudBackupOnBoot() {
    if (this.store.schedule().length > 0) return; // Only prompt if local is empty
    try {
      const { restoreScheduleSettings } = await import('./firebase-client');
      const data = await restoreScheduleSettings();
      if (data && data['schedule'] && data['schedule'].length > 0) {
        this.cloudBackupAvailable.set(data as BackupData);
        this.showRestorePrompt.set(true);
      }
    } catch (e) {
      console.warn('Failed to check cloud backup on boot:', e);
    }
  }

  async acceptRestorePrompt() {
    const data = this.cloudBackupAvailable();
    if (data) {
      this.isProcessing.set(true);
      try {
        if (data.schedule) this.store.updateSchedule(data.schedule);
        if (data.settings) this.store.settings.set(data.settings);
        if (data.active !== undefined) this.store.isActive.set(data.active);
        await this.notification.verifyAndHealSchedule(); // Recreate native alarms
        this.showRestorePrompt.set(false);
      } catch (e) {
         console.error('Auto restore failed:', e);
      }
      this.isProcessing.set(false);
    }
  }

  async forceBackupData() {
    this.isProcessing.set(true);
    try {
      const { backupScheduleSettings } = await import('./firebase-client');
      // Already running implicitly via effect in store but we can force it here
      await backupScheduleSettings(this.store.schedule(), this.store.settings(), this.store.isActive());
      alert('สำรองข้อมูลขึ้นคลาวด์สำเร็จแล้ว');
    } catch (e) {
      console.error('Cloud backup error:', e);
      alert('เกิดข้อผิดพลาดในการสำรองข้อมูล');
    }
    this.isProcessing.set(false);
  }
  
  async restoreData() {
    this.isProcessing.set(true);
    try {
      await this.store.restoreFromCloud();
      await this.notification.verifyAndHealSchedule(); // ensure alarms are recreated
      alert('กู้คืนข้อมูลและอัปเดตตารางสำหรับเครื่องนี้เรียบร้อยแล้ว');
      this.setTab('home');
    } catch (e) {
      console.error('Cloud restore error:', e);
      alert('ไม่พบข้อมูลสำรองบนคลาวด์ หรือเกิดข้อผิดพลาด');
    }
    this.isProcessing.set(false);
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

  async startAppKillSandboxTest(seconds: number) {
    if (this.notificationPermission() !== 'granted') {
      const granted = await this.notification.requestPermission();
      if (typeof window !== 'undefined' && 'Notification' in window) {
        this.notificationPermission.set(Notification.permission);
      }
      if (!granted) {
        alert('กรุณาอนุญาตการแจ้งเตือนก่อนทำการตรวจสอบระบบฆ่าแอป');
        return;
      }
    }

    // Call service to schedule in native OS (even after app close)
    await this.notification.scheduleSandboxNotification(seconds);

    // Initial countdown setup
    this.appKillSandboxCountdown.set(seconds);
    this.appKillSandboxActive.set(true);

    if (this.appKillSandboxTimerId) {
      clearInterval(this.appKillSandboxTimerId);
    }

    // Set countdown timer
    this.appKillSandboxTimerId = setInterval(() => {
      const current = this.appKillSandboxCountdown();
      if (current <= 1) {
        if (this.appKillSandboxTimerId) {
          clearInterval(this.appKillSandboxTimerId);
          this.appKillSandboxTimerId = null;
        }
        this.appKillSandboxActive.set(false);
        this.appKillSandboxCountdown.set(0);
      } else {
        this.appKillSandboxCountdown.set(current - 1);
      }
    }, 1000);
  }

  cancelAppKillSandboxTest() {
    if (this.appKillSandboxTimerId) {
      clearInterval(this.appKillSandboxTimerId);
      this.appKillSandboxTimerId = null;
    }
    this.appKillSandboxActive.set(false);
    this.appKillSandboxCountdown.set(0);
    this.notification.cancelSandboxNotification();
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

  // Administrative Operations & Google Auth Controllers
  async loginAsAdmin() {
    this.isProcessing.set(true);
    try {
      const { signInWithGoogle } = await import('./firebase-client');
      const user = await signInWithGoogle();
      if (user) {
        if (user.email === 'khaophan.po@gmail.com') {
          this.adminUser.set(user);
          this.setTab('admin');
        } else {
          const { logout } = await import('./firebase-client');
          await logout();
          this.adminUser.set(null);
          alert('สิทธิ์ปฏิเสธการเข้าสู่ระบบ: อีเมลของคุณไม่ใช่ khaophan.po@gmail.com');
        }
      }
    } catch (e) {
      console.error('Login error:', e);
      const err = e as Error;
      alert('เกิดข้อผิดพลาดในการเข้าสู่ระบบด้วย Google: ' + (err.message || String(e)));
    } finally {
      this.isProcessing.set(false);
    }
  }

  async logoutAdmin() {
    this.isProcessing.set(true);
    try {
      const { logout } = await import('./firebase-client');
      await logout();
      this.adminUser.set(null);
      this.setTab('home');
    } catch (e) {
      console.error('Logout error:', e);
    } finally {
      this.isProcessing.set(false);
    }
  }

  async saveAdminGlobalSettings() {
    this.isProcessing.set(true);
    try {
      const { saveGlobalConfig } = await import('./firebase-client');
      const newConfig: GlobalConfig = {
        backendApiUrl: this.adminBackendApiUrl().trim(),
        broadcastText: this.adminBroadcastText().trim(),
        maintenanceMode: this.adminMaintenanceMode(),
        githubRepo: this.adminGithubRepo().trim(),
        subjectMappings: this.adminSubjectMappings(),
        updatedAt: new Date().toISOString()
      };
      await saveGlobalConfig(newConfig);
      alert('อัปเดตข้อมูลการตั้งค่าแอดมินและซิงก์สู่มือถือผู้ใช้ทั่วโลกสำเร็จแล้ว! 🌐🚀');
    } catch (e) {
      console.error('Save config error:', e);
      const err = e as Error;
      alert('ไม่สามารถอัปเดตการทำงาน คาดว่ามีข้อผิดพลาดเกี่ยวกับการยืนยันตัวตนแอดมิน: ' + (err.message || String(e)));
    } finally {
      this.isProcessing.set(false);
    }
  }

  saveAdminMapping() {
    const code = this.newAdminMappingCode().trim().toUpperCase();
    const name = this.newAdminMappingName().trim();
    if (!code || !name) return;

    const current = this.adminSubjectMappings();
    this.adminSubjectMappings.set({ ...current, [code]: name });
    this.newAdminMappingCode.set('');
    this.newAdminMappingName.set('');
  }

  removeAdminMapping(code: string) {
    const updated = { ...this.adminSubjectMappings() };
    delete updated[code];
    this.adminSubjectMappings.set(updated);
  }

  async importAdminMappings(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    
    const file = input.files[0];
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    
    const current = this.adminSubjectMappings();
    const updated = { ...current };
    let importedCount = 0;
    
    for (const line of lines) {
      if (!line.trim()) continue;
      let matched = false;
      if (line.includes('> |')) {
        const [code, name] = line.split('> |');
        updated[code.trim().toUpperCase()] = name.trim();
        matched = true;
      } else if (line.includes('|')) {
        const [code, name] = line.split('|');
        updated[code.trim().toUpperCase()] = name.trim();
        matched = true;
      } else if (line.includes('=')) {
        const [code, name] = line.split('=');
        updated[code.trim().toUpperCase()] = name.trim();
        matched = true;
      }
      if (matched) importedCount++;
    }
    
    if (importedCount > 0) {
      this.adminSubjectMappings.set(updated);
      alert(`นำเข้ารายวิชาแอดมินสำเร็จ ${importedCount} รายการ (โปรดกดบันทึกเพื่อซิงก์ข้อมูลไปมือถือครอบคลุมทั่วโลก)`);
    } else {
      alert('ไม่พบข้อมูลรูปแบบที่ใช้จับคู่รหัสได้ เกร็ดตัวอย่าง: ว30103 = วิทยาศาสตร์');
    }
    input.value = '';
  }
}

