import { Injectable, signal, effect } from '@angular/core';
import { ClassSession, AppSettings, ActiveNotification } from './models';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { backupScheduleSettings, restoreScheduleSettings, subscribeToGlobalConfig, GlobalConfig } from './firebase-client';

@Injectable({ providedIn: 'root' })
export class AppStore {
  readonly schedule = signal<ClassSession[]>([]);
  readonly settings = signal<AppSettings>({
    notifyTeacher: true,
    notifySubjectCode: true,
    notifySubjectName: true,
    notifyRoom: true,
    notifyEnd: true,
    popupDuration: 10,
    preNotifyMinutes: 3,
    calendarHolidays: {},
  });
  readonly isActive = signal<boolean>(true);
  readonly activeNotification = signal<ActiveNotification | null>(null);
  readonly globalConfig = signal<GlobalConfig | null>(null);

  constructor() {
    this.loadState();

    if (typeof window !== 'undefined') {
      subscribeToGlobalConfig((config) => {
        if (config) {
          console.log('[AppStore] Received global config update from Admin:', config);
          this.globalConfig.set(config);
          
          if (config.subjectMappings) {
            try {
              const localSaved = localStorage.getItem('subject_mappings') || '{}';
              const localMap = JSON.parse(localSaved);
              const merged = { ...localMap, ...config.subjectMappings };
              localStorage.setItem('subject_mappings', JSON.stringify(merged));
            } catch (e) {
              console.warn('[AppStore] Merging admin subject mappings failed:', e);
            }
          }
        }
      });
    }
    
    // Save state on change
    let cloudSyncTimeout: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const currentSchedule = this.schedule();
      const currentSettings = this.settings();
      const currentActive = this.isActive();
      
      const saveAsync = async () => {
        try {
          // Local storage is immediate
          if (Capacitor.isNativePlatform()) {
            await Preferences.set({ key: 'sched_schedule', value: JSON.stringify(currentSchedule) });
            await Preferences.set({ key: 'sched_settings', value: JSON.stringify(currentSettings) });
            await Preferences.set({ key: 'sched_active', value: JSON.stringify(currentActive) });
          } else if (typeof localStorage !== 'undefined') {
            localStorage.setItem('sched_schedule', JSON.stringify(currentSchedule));
            localStorage.setItem('sched_settings', JSON.stringify(currentSettings));
            localStorage.setItem('sched_active', JSON.stringify(currentActive));
          }
          
          // Cloud backup is debounced to avoid quota/spamming on rapid changes
          if (cloudSyncTimeout) clearTimeout(cloudSyncTimeout);
          cloudSyncTimeout = setTimeout(async () => {
             console.log('Debounced cloud sync executing...');
             await backupScheduleSettings(currentSchedule, currentSettings, currentActive);
          }, 5000); // 5 seconds debounce
        } catch (e) {
          console.warn('Failed to save state:', e);
        }
      };
      
      saveAsync();
    });
  }

  private cleanUpSchedule(list: ClassSession[]): ClassSession[] {
    return list.map(session => {
      // Check if it is the 10th period (starting at 15:40)
      if (session.startTime === '15:40') {
        const trimmedCode = (session.subjectCode || '').trim();
        const trimmedName = (session.subjectName || '').trim();
        const trimmedTeacher = (session.teacher || '').trim();
        const trimmedRoom = (session.room || '').trim();

        // If it was empty or has "โฮมรูม" but lacks all other class-specific data
        if (
          (!trimmedCode && !trimmedTeacher && !trimmedRoom) ||
          ((trimmedName === 'โฮมรูม' || !trimmedName) && !trimmedCode && !trimmedTeacher && !trimmedRoom) ||
          trimmedName === 'เลิกเรียน'
        ) {
          return {
            ...session,
            subjectCode: '',
            subjectName: 'เลิกเรียน',
            teacher: '',
            room: ''
          };
        }
      }
      return session;
    });
  }

  private async loadState() {
    try {
      let storedSchedule: string | null = null;
      let storedSettings: string | null = null;
      let storedActive: string | null = null;

      if (Capacitor.isNativePlatform()) {
        storedSchedule = (await Preferences.get({ key: 'sched_schedule' })).value;
        storedSettings = (await Preferences.get({ key: 'sched_settings' })).value;
        storedActive = (await Preferences.get({ key: 'sched_active' })).value;
      } else if (typeof localStorage !== 'undefined') {
        storedSchedule = localStorage.getItem('sched_schedule');
        storedSettings = localStorage.getItem('sched_settings');
        storedActive = localStorage.getItem('sched_active');
      }

      if (storedSchedule) {
        const parsed = JSON.parse(storedSchedule);
        this.schedule.set(this.cleanUpSchedule(parsed));
      }
      if (storedSettings) this.settings.set(JSON.parse(storedSettings));
      if (storedActive !== null) this.isActive.set(JSON.parse(storedActive));
    } catch (e) {
      console.error('Failed to load state', e);
    }
  }

  async restoreFromCloud() {
    try {
      const data = await restoreScheduleSettings();
      if (data) {
        if (data['schedule']) this.schedule.set(this.cleanUpSchedule(data['schedule']));
        if (data['settings']) this.settings.set(data['settings']);
        if (data['active'] !== undefined) this.isActive.set(data['active']);
      }
    } catch (e) {
      console.warn('Failed to restore from cloud:', e);
    }
  }

  updateSchedule(newSchedule: ClassSession[]) {
    this.schedule.set(this.cleanUpSchedule(newSchedule));
  }

  updateSettings(newSettings: Partial<AppSettings>) {
    this.settings.update(s => ({ ...s, ...newSettings }));
  }

  toggleActive(active: boolean) {
    this.isActive.set(active);
  }

  async resetAll() {
    this.schedule.set([]);
    this.settings.set({
      notifyTeacher: true,
      notifySubjectCode: true,
      notifySubjectName: true,
      notifyRoom: true,
      notifyEnd: true,
      popupDuration: 10,
      preNotifyMinutes: 3,
      calendarHolidays: {},
    });
    this.isActive.set(true);
    this.activeNotification.set(null);

    try {
      if (Capacitor.isNativePlatform()) {
        await Preferences.remove({ key: 'sched_schedule' });
        await Preferences.remove({ key: 'sched_settings' });
        await Preferences.remove({ key: 'sched_active' });
      } else if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('sched_schedule');
        localStorage.removeItem('sched_settings');
        localStorage.removeItem('sched_active');
      }
    } catch (e) {
      console.warn('Failed to clear state:', e);
    }
  }
}
