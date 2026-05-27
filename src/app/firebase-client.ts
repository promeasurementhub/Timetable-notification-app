import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

let messaging: ReturnType<typeof getMessaging> | null = null;
if (typeof window !== 'undefined' && 'Notification' in window) {
  try {
    messaging = getMessaging(app);
  } catch (err) {
    console.warn('Firebase messaging not supported in this environment', err);
  }
}

export const requestFirebaseNotificationPermission = async () => {
  if (!messaging) return null;
  
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      const token = await getToken(messaging);
      if (token) {
        console.log('FCM Token:', token);
        // Save the token to Firestore so a backend could use it
        await setDoc(doc(db, 'devices', token), {
          token,
          createdAt: new Date().toISOString(),
          platform: 'web'
        });
        return token;
      }
    }
    return null;
  } catch (error) {
    console.error('An error occurred while retrieving token. ', error);
    return null;
  }
};

if (messaging) {
  onMessage(messaging, (payload) => {
    console.log('Message received. ', payload);
    // The service worker handles background notifications.
    // We can also trigger local visual updates here if the app is foregrounded.
  });
}

export { messaging };
