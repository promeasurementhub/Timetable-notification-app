import { initializeApp } from 'firebase/app';
import { getMessaging, onMessage } from 'firebase/messaging';
import { initializeFirestore, doc, setDoc, getDoc, onSnapshot, DocumentReference, DocumentSnapshot } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true
}, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Resilient wrapper for getDoc that handles transient offline/unavailable failures gracefully
const getDocWithRetry = async (docRef: DocumentReference, retries = 3, delayMs = 1500): Promise<DocumentSnapshot> => {
  for (let i = 0; i < retries; i++) {
    try {
      return await getDoc(docRef);
    } catch (err) {
      const error = err as { code?: string; message?: string };
      const isOfflineError = !!(error && (
        error.code === 'unavailable' || 
        (error.message && error.message.toLowerCase().includes('offline'))
      ));
      if (isOfflineError && i < retries - 1) {
        console.warn(`Firestore is offline/unavailable. Retrying getDoc in ${delayMs}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  return await getDoc(docRef);
};

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
    const snap = await getDocWithRetry(doc(db, 'global_settings', 'config'));
    if (snap.exists()) {
      return snap.data() as GlobalConfig;
    }
  } catch (err) {
    const error = err as { code?: string; message?: string };
    const isOffline = !!(error && (error.code === 'unavailable' || (error.message && error.message.toLowerCase().includes('offline'))));
    if (isOffline) {
      console.warn('Failed to get global configs (client is offline - this is expected in offline mode)');
    } else {
      console.error('Failed to get global configs:', err);
    }
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
  if (auth.currentUser) return auth.currentUser.uid;
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
    await syncNotificationQueue(uid, schedule as any[], settings as any, active as boolean);
  } catch (err) {
    console.error('Failed to backup schedule data:', err);
  }
};

const syncNotificationQueue = async (uid: string, schedule: any[], settings: any, active: boolean) => {
  if (!active || !schedule || schedule.length === 0) return;
  try {
    const { writeBatch, collection, query, where, getDocs, doc } = await import('firebase/firestore');
    
    // 1. Delete all existing pending notifications first
    const pendingQuery = query(collection(db, 'notifications'), where('userId', '==', uid), where('status', '==', 'pending'));
    const pendingSnaps = await getDocs(pendingQuery);
    
    const batch = writeBatch(db);
    
    pendingSnaps.forEach(snap => {
        batch.delete(snap.ref);
    });
    
    // Day mapping
    const now = new Date();
    const dayMap: Record<string, number> = {
      'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6
    };
    
    // Generate for next 7 days
    for (let i = 0; i < 7; i++) {
        const targetDate = new Date(now);
        targetDate.setDate(targetDate.getDate() + i);
        const targetClassDay = targetDate.getDay();
        
        for (const session of schedule) {
           if (!session.dayOfWeek) continue;
           const sessionDay = dayMap[session.dayOfWeek.trim().toLowerCase()];
           if (sessionDay === targetClassDay) {
               
               const [startH, startM] = session.startTime.split(':').map(Number);
               const preNotifyMinutes = settings.preNotifyMinutes !== undefined ? settings.preNotifyMinutes : 3;
               let notifyH = startH;
               let notifyM = startM - preNotifyMinutes;
               
               while (notifyM < 0) { notifyM += 60; notifyH -= 1; }
               if (notifyH < 0) { notifyH = (notifyH % 24 + 24) % 24; }
               
               const notifyTime = new Date(targetDate);
               notifyTime.setHours(notifyH, notifyM, 0, 0);
               
               if (notifyTime > now) {
                   const notifId = `${uid}_start_${session.id}_${notifyTime.getTime()}`;
                   const notifRef = doc(collection(db, 'notifications'), notifId);
                   
                   const subjectName = session.subjectName || session.subjectCode || 'ไม่ระบุวิชา';
                   const bodyText = preNotifyMinutes > 0 
                     ? `อีก ${preNotifyMinutes} นาทีจะเริ่มเรียน\nวิชา: ${subjectName}\nเวลา: ${session.startTime} น.`
                     : `ได้เวลาเริ่มเรียน\nวิชา: ${subjectName}\nเวลา: ${session.startTime} น.`;
                     
                   batch.set(notifRef, {
                       userId: uid,
                       sendAt: notifyTime.toISOString(),
                       timestamp: notifyTime.getTime(),
                       title: preNotifyMinutes > 0 ? `แจ้งเตือนเข้าเรียน (ล่วงหน้า ${preNotifyMinutes} นาที)` : 'แจ้งเตือนเริ่มชั้นเรียน',
                       body: bodyText,
                       status: 'pending',
                       createdAt: new Date().toISOString()
                   });
               }
           }
        }
    }
    
    await batch.commit();
    console.log('Notification queue synced successfully.');
  } catch (err) {
    console.error('Failed to sync notification queue:', err);
  }
};

export const fetchDiagnosticInfo = async () => {
  const uid = getOrCreateUserUid();
  let pushToken = localStorage.getItem('fcm_token_granted') ? 'Granted/Subscribed' : 'Not Subscribed';
  let subscriptionStatus = 'Inactive';
  let queueItems: any[] = [];
  let logItems: any[] = [];
  let sCount = 0;
  let fCount = 0;
  
  try {
    const { collection, query, where, getDocs, limit } = await import('firebase/firestore');
    
    // Subscriptions
    const subQuery = query(collection(db, "pushSubscriptions"), where("userId", "==", uid), limit(1));
    const subSnaps = await getDocs(subQuery);
    if (!subSnaps.empty) {
        subscriptionStatus = 'Registered & Active';
        pushToken = subSnaps.docs[0].data()['endpoint'].substring(0, 50) + '...';
    }

    // Queue
    const qQuery = query(collection(db, "notifications"), where("userId", "==", uid), limit(50));
    const qSnaps = await getDocs(qQuery);
    queueItems = qSnaps.docs.map(d => ({id: d.id, ...d.data()}));
    queueItems.sort((a, b) => new Date(a['sendAt']).getTime() - new Date(b['sendAt']).getTime());

    // Logs
    const lQuery = query(collection(db, "notificationLogs"), where("userId", "==", uid), limit(50));
    const lSnaps = await getDocs(lQuery);
    logItems = lSnaps.docs.map(d => {
        const data = d.data();
        if (data['status'] === 'sent') sCount++;
        if (data['status'] === 'failed') fCount++;
        return {id: d.id, ...data};
    });
    logItems.sort((a, b) => new Date(b['sentAt'] as string).getTime() - new Date(a['sentAt'] as string).getTime());

  } catch(e) {
    console.error("fetchDiagnosticInfo Error:", e);
    // Ignore permissions errors
  }
  
  return { pushToken, subscriptionStatus, queueItems, logItems, sCount, fCount };
};

export const restoreScheduleSettings = async () => {
  if (typeof window === 'undefined') return null;
  try {
    const uid = getOrCreateUserUid();
    const snap = await getDocWithRetry(doc(db, 'users', uid, 'backup', 'data'));
    if (snap.exists()) {
      console.log('Schedule data restored from cloud successfully.');
      return snap.data();
    }
  } catch (err) {
    const error = err as { code?: string; message?: string };
    const isOffline = !!(error && (error.code === 'unavailable' || (error.message && error.message.toLowerCase().includes('offline'))));
    if (isOffline) {
      console.warn('Failed to restore schedule data: client is offline (this is a normal expected behavior in offline mode)');
    } else {
      console.error('Failed to restore schedule data:', err);
    }
  }
  return null;
};

export const requestFirebaseNotificationPermission = async () => {
  if (typeof window === 'undefined') return null;

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      
      const swRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { type: 'module' });
      await navigator.serviceWorker.ready;
      
      // Fetch Vapid Public Key from backend
      const res = await fetch('/api/push/vapidPublicKey');
      const { publicKey } = await res.json();
      
      // Convert VAPID key to Uint8Array
      const padding = '='.repeat((4 - publicKey.length % 4) % 4);
      const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }
      
      // Subscribe to Web Push
      const subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: outputArray
      });

      const subData = JSON.parse(JSON.stringify(subscription));

      const uid = getOrCreateUserUid();
      await setDoc(doc(db, 'pushSubscriptions', subData.endpoint.split('/').pop() || uid), {
        userId: uid,
        endpoint: subData.endpoint,
        keys: subData.keys,
        createdAt: new Date().toISOString()
      }, { merge: true });

      localStorage.setItem('fcm_token_granted', 'true');
      console.log('Web Push Subscription saved successfully.');
      return subData.endpoint;
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
