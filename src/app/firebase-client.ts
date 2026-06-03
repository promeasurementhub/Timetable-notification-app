import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { getFirestore, doc, setDoc, getDoc, onSnapshot } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Force prompt so users can switch accounts if they need to
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

// Admin email identification
export const ADMIN_EMAIL = 'khaophan.po@gmail.com';

let messaging: ReturnType<typeof getMessaging> | null = null;
if (typeof window !== 'undefined' && 'Notification' in window) {
  try {
    messaging = getMessaging(app);
  } catch (err) {
    console.warn('Firebase messaging not supported in this environment', err);
  }
}

export interface GlobalConfig {
  backendApiUrl: string;
  subjectMappings: Record<string, string>;
  githubRepo: string;
  broadcastText: string;
  maintenanceMode: boolean;
  updatedAt: string;
}

// Google Login only
export const signInWithGoogle = async (): Promise<User | null> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (err) {
    console.error('Failed to login with Google:', err);
    throw err;
  }
};

export const logout = async (): Promise<void> => {
  await signOut(auth);
};

// Global Configuration admin controls
export const getGlobalConfig = async (): Promise<GlobalConfig | null> => {
  try {
    const snap = await getDoc(doc(db, 'global_settings', 'config'));
    if (snap.exists()) {
      return snap.data() as GlobalConfig;
    }
  } catch (err) {
    console.error('Failed to get global configs:', err);
  }
  return null;
};

export const saveGlobalConfig = async (newConfig: GlobalConfig): Promise<void> => {
  try {
    await setDoc(doc(db, 'global_settings', 'config'), {
      ...newConfig,
      updatedAt: new Date().toISOString()
    });
    console.log('Global configuration updated by Admin successfully.');
  } catch (err) {
    console.error('Failed to update global config:', err);
    throw err;
  }
};

export const subscribeToGlobalConfig = (callback: (config: GlobalConfig | null) => void) => {
  return onSnapshot(doc(db, 'global_settings', 'config'), (snap) => {
    if (snap.exists()) {
      callback(snap.data() as GlobalConfig);
    } else {
      callback(null);
    }
  }, (err) => {
    console.error('Error listening to global configurations:', err);
  });
};

export const getOrCreateUserUid = (): string => {
  if (typeof window === 'undefined') return 'unknown_user';
  let uid = localStorage.getItem('app_user_uid');
  if (!uid) {
    uid = 'user_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    localStorage.setItem('app_user_uid', uid);
  }
  return uid;
};

export const uploadDiagnosticLogs = async (logs: unknown[]) => {
  if (typeof window === 'undefined') return;
  try {
    const uid = getOrCreateUserUid();
    const logDoc = doc(db, 'users', uid, 'diagnostics', new Date().toISOString());
    await setDoc(logDoc, {
      logs,
      uploadedAt: new Date().toISOString(),
      userAgent: navigator.userAgent
    });
    console.log('Diagnostic logs uploaded successfully.');
  } catch (err) {
    console.error('Failed to upload diagnostic logs to Firebase:', err);
  }
};

export const backupScheduleSettings = async (schedule: unknown, settings: unknown, active: unknown) => {
  if (typeof window === 'undefined') return;
  try {
    const uid = getOrCreateUserUid();
    await setDoc(doc(db, 'users', uid, 'backup', 'data'), {
      schedule,
      settings,
      active,
      updatedAt: new Date().toISOString()
    });
    console.log('Schedule data backed up to cloud successfully.');
  } catch (err) {
    console.error('Failed to backup schedule data:', err);
  }
};

export const restoreScheduleSettings = async () => {
  if (typeof window === 'undefined') return null;
  try {
    const uid = getOrCreateUserUid();
    const snap = await getDoc(doc(db, 'users', uid, 'backup', 'data'));
    if (snap.exists()) {
      console.log('Schedule data restored from cloud successfully.');
      return snap.data();
    }
  } catch (err) {
    console.error('Failed to restore schedule data:', err);
  }
  return null;
};

export const requestFirebaseNotificationPermission = async () => {
  if (!messaging) return null;
  if (typeof window === 'undefined') return null;

  try {
    // 1. ตรวจสอบว่าเคยได้ Token หรือยังจาก LocalStorage 
    // เพื่อป้องกันการขอรับ Token ซ้ำและลดภาระของ Firebase
    const cachedToken = localStorage.getItem('fcm_token');
    if (cachedToken && Notification.permission === 'granted') {
      console.log('Using cached FCM token.');
      return cachedToken;
    }

    // 2. ขอสิทธิ์ Notification Permission
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      
      // 3. ลงทะเบียนและรับ Service Worker สำหรับจัดการ background Notification
      const swRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { type: 'module' });

      // 4. สมัครรับ Push Notification และได้ FCM Token
      // เราใช้ serviceWorkerRegistration ที่แน่ใจว่าเชื่อมต่อถูกต้อง
      const token = await getToken(messaging, {
        serviceWorkerRegistration: swRegistration,
      });

      if (token) {
        console.log('FCM Token received:', token);
        const uid = getOrCreateUserUid();
        
        // 5. บันทึก Token ลง Firestore ถือว่าจัดการเชื่อมกับ user uid (เป็น anonymous uuid)
        // เพื่อให้ฝั่ง backend นำไปใช้ส่งข้อความตามเวลาได้
        await setDoc(doc(db, 'users', uid, 'devices', token), {
          token,
          createdAt: new Date().toISOString(),
          platform: 'web',
          uid: uid
        }, { merge: true });

        // เก็บไว้ใน LocalStorage ว่าเคยได้ Token แล้ว
        localStorage.setItem('fcm_token', token);

        return token;
      } else {
        console.warn('No registration token available. Request permission to generate one.');
      }
    }
    return null;
  } catch (error) {
    console.error('An error occurred while retrieving token: ', error);
    return null;
  }
};

// 6. เมื่อขณะที่มีการเปิดเว็บนี้ใน foreground, ทำการรับ notification ตรงนี้
if (messaging) {
  onMessage(messaging, (payload) => {
    console.log('[Foreground] Message received. ', payload);
    // แจ้งเตือนผู้ใช้ในเว็บเมื่อได้รับ push (แต่อยู่ในหน้าเว็บอยู่แล้ว)
    // สำหรับ background, firebase-messaging-sw.js จะเป็นผู้ทำงาน
  });
}

export { messaging };
