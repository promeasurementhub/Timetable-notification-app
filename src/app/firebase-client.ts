import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, enableIndexedDbPersistence, getDocFromCache, getDocFromServer } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

if (typeof window !== 'undefined') {
  enableIndexedDbPersistence(db).catch((err) => {
    if (err.code === 'failed-precondition') {
      console.warn('Firestore persistence failed-precondition: Multiple tabs open.');
    } else if (err.code === 'unimplemented') {
      console.warn('Firestore persistence unimplemented in this browser.');
    }
  });

  // Test connection to Firestore on boot as per Critical Constraint
  getDocFromServer(doc(db, 'test', 'connection')).catch((error) => {
    if (error instanceof Error && (error.message.includes('the client is offline') || error.message.includes('offline'))) {
      console.warn('[Firestore] Operating in offline mode. Please check your network connection.');
    }
  });
}

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

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('[Firestore Error]: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Global Configuration admin controls
export const getGlobalConfig = async (): Promise<GlobalConfig | null> => {
  const path = 'global_settings/config';
  const docRef = doc(db, 'global_settings', 'config');
  try {
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data() as GlobalConfig;
    }
  } catch (err) {
    const errorWithCode = err as { code?: string; message?: string };
    if (errorWithCode?.code === 'unavailable' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      console.warn('[Firestore] getGlobalConfig: Client is offline. Fetching from cache if available...');
      try {
        const cacheSnap = await getDocFromCache(docRef);
        if (cacheSnap.exists()) {
          return cacheSnap.data() as GlobalConfig;
        }
      } catch (cacheErr) {
        console.warn('[Firestore] Failed to get global configuration from cache:', cacheErr);
      }
    } else {
      handleFirestoreError(err, OperationType.GET, path);
    }
  }
  return null;
};

export const saveGlobalConfig = async (newConfig: GlobalConfig): Promise<void> => {
  const path = 'global_settings/config';
  try {
    await setDoc(doc(db, 'global_settings', 'config'), {
      ...newConfig,
      updatedAt: new Date().toISOString()
    });
    console.log('Global configuration updated by Admin successfully.');
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
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
    
    // Fetch client IP address to associate with this backup and device identity
    let clientIp = 'unknown';
    try {
      const ipRes = await fetch('/api/ip');
      if (ipRes.ok) {
        const ipData = await ipRes.json();
        if (ipData && ipData.ip) {
          clientIp = ipData.ip;
        }
      }
    } catch (e) {
      console.warn('Could not retrieve client IP:', e);
    }

    const userRootRef = doc(db, 'users', uid);
    await setDoc(userRootRef, {
      updatedAt: new Date().toISOString(),
      ipAddress: clientIp,
      active: active
    }, { merge: true });

    await setDoc(doc(db, 'users', uid, 'backup', 'data'), {
      schedule,
      settings,
      active,
      ipAddress: clientIp,
      updatedAt: new Date().toISOString()
    });
    console.log(`Schedule data backed up to cloud successfully for IP: ${clientIp}`);
  } catch (err) {
    console.error('Failed to backup schedule data:', err);
  }
};

export const restoreScheduleSettings = async () => {
  if (typeof window === 'undefined') return null;
  const uid = getOrCreateUserUid();
  const docRef = doc(db, 'users', uid, 'backup', 'data');
  try {
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      console.log('Schedule data restored from cloud successfully.');
      return snap.data();
    }
  } catch (err) {
    const errorWithCode = err as { code?: string; message?: string };
    if (errorWithCode?.code === 'unavailable' || !navigator.onLine) {
      console.warn('[Firestore] restoreScheduleSettings: Client is offline. Fetching from cache if available...');
      try {
        const cacheSnap = await getDocFromCache(docRef);
        if (cacheSnap.exists()) {
          console.log('Schedule data restored from local cache successfully.');
          return cacheSnap.data();
        }
      } catch (cacheErr) {
        console.warn('[Firestore] Failed to restore schedule settings from cache:', cacheErr);
      }
    } else {
      console.info('[Firestore] Failed to restore schedule data (unhandled):', err);
    }
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

        // Fetch client IP address to associate with this device registration
        let clientIp = 'unknown';
        try {
          const ipRes = await fetch('/api/ip');
          if (ipRes.ok) {
            const ipData = await ipRes.json();
            if (ipData && ipData.ip) {
              clientIp = ipData.ip;
            }
          }
        } catch (e) {
          console.warn('Could not retrieve client IP:', e);
        }
        
        // 5. บันทึก Token ลง Firestore ถือว่าจัดการเชื่อมกับ user uid (เป็น anonymous uuid)
        // เพื่อให้ฝั่ง backend นำไปใช้ส่งข้อความตามเวลาได้
        await setDoc(doc(db, 'users', uid, 'devices', token), {
          token,
          createdAt: new Date().toISOString(),
          platform: 'web',
          uid: uid,
          ipAddress: clientIp
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
