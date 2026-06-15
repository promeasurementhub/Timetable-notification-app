import webpush from 'web-push';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, where, updateDoc, doc, addDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import fs from 'node:fs';
import path from 'node:path';

// Keys
let publicVapidKey = process.env['VAPID_PUBLIC_KEY'];
let privateVapidKey = process.env['VAPID_PRIVATE_KEY'];

if (!publicVapidKey || !privateVapidKey) {
    const vapidKeys = webpush.generateVAPIDKeys();
    publicVapidKey = vapidKeys.publicKey;
    privateVapidKey = vapidKeys.privateKey;
    console.warn("Using ephemeral VAPID keys. Subscriptions will break on restart.");
}

webpush.setVapidDetails('mailto:khaophan.po@gmail.com', publicVapidKey, privateVapidKey);

export function getVapidPublicKey() {
    return publicVapidKey;
}

// Init Firebase
let db: any;
let isReady = false;
let authUser: any;

export async function processNotificationQueue() {
    if (!isReady) return;
    try {
        const now = new Date();
        const pendingQuery = query(collection(db, "notifications"), 
            where("status", "==", "pending")
        );
        const snaps = await getDocs(pendingQuery);
        
        snaps.forEach(async (docSnap) => {
            const nData = docSnap.data();
            const sendAtDate = new Date(nData['sendAt']);
            
            if (now >= sendAtDate) {
                // Time to send!
                await sendPushForNotification(docSnap.id, nData);
            }
        });
    } catch (e) {
        console.error("Queue process error:", e);
    }
}
export async function initPushWorker() {
    try {
        const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        const app = initializeApp(configData);
        db = getFirestore(app);
        const auth = getAuth(app);
        
        const email = 'backend_scheduler_robot@system.local';
        const password = 'VerySecureBackendPassword123!';
        
        try {
            const cred = await signInWithEmailAndPassword(auth, email, password);
            authUser = cred.user;
            console.log("Backend Worker Authenticated.");
        } catch (err: any) {
            if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
                const cred = await createUserWithEmailAndPassword(auth, email, password);
                authUser = cred.user;
                console.log("Backend Worker Account Created.");
            } else {
                throw err;
            }
        }
        
        isReady = true;
        
        // Start 24/7 worker
        setInterval(processNotificationQueue, 60000);
        console.log("Notification Worker 24/7 Started.");
        
        // Process queue immediately
        processNotificationQueue();
    } catch(e) {
        console.error("Worker Init Failed:", e);
    }
}



async function sendPushForNotification(id: string, nData: any) {
    try {
        // Find subscriptions for user
        const subQuery = query(collection(db, "pushSubscriptions"), where("userId", "==", nData['userId']));
        const subSnaps = await getDocs(subQuery);
        
        let sent = false;
        const promises: Promise<any>[] = [];
        
        subSnaps.forEach(subSnap => {
            const subData = subSnap.data();
            const payload = JSON.stringify({
                title: nData['title'],
                body: nData['body'],
                icon: '/app-icon-192.png',
                url: '/'
            });
            
            const sub = {
                endpoint: subData['endpoint'],
                keys: subData['keys']
            };
            
            promises.push(
                webpush.sendNotification(sub, payload).then(() => {
                    sent = true;
                }).catch(async (err) => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        // Expired
                        await deleteDoc(doc(db, "pushSubscriptions", subSnap.id));
                    }
                    console.error("Push Error:", err);
                })
            );
        });
        
        await Promise.all(promises);
        
        const status = sent ? 'sent' : 'failed';
        await updateDoc(doc(db, "notifications", id), { status });
        
        await addDoc(collection(db, "notificationLogs"), {
            userId: nData['userId'],
            notificationId: id,
            status: status,
            sentAt: new Date().toISOString()
        });
        
    } catch (e) {
        console.error("Send push failed for", id, e);
    }
}