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
  deferredPrompt = signal<any>(null);
  editingSession = signal<ClassSession | null>(null);

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

      window.addEventListener('beforeinstallprompt', (e) => {
        // Prevent the mini-infobar from appearing on mobile
        e.preventDefault();
        // Stash the event so it can be triggered later.
        this.deferredPrompt.set(e);
      });

      window.addEventListener('appinstalled', () => {
        this.deferredPrompt.set(null);
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

  private async getPref(key: string, fallback: string = ''): Promise<string> {
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
    
    this.newMappingCode.set('');
    this.newMappingName.set('');
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
    const current = this.subjectMappings();
    const { [code]: _, ...updated } = current;
    this.subjectMappings.set(updated);
    await this.setPref('subject_mappings', JSON.stringify(updated));
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

  async ngOnInit() {
    this.notification.startChecking();
    
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
          this.store.updateSchedule(parsed);
          this.setTab('home');
        } catch (err: any) {
          console.error(err);
          alert(`ไม่สามารถวิเคราะห์ตารางเรียนได้: ${err.message || 'กรุณาลองใหม่อีกครั้ง'}`);
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

