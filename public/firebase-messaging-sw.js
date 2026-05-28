importScripts(
  "https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js",
);
importScripts(
  "https://www.gstatic.com/firebasejs/10.9.0/firebase-messaging-compat.js",
);

firebase.initializeApp({
  apiKey: "AIzaSyA1lzZpO5G-T9V-Kp_Tve31O8rIH0eldDk",
  authDomain: "gen-lang-client-0556152514.firebaseapp.com",
  projectId: "gen-lang-client-0556152514",
  storageBucket: "gen-lang-client-0556152514.firebasestorage.app",
  messagingSenderId: "227977579604",
  appId: "1:227977579604:web:6b5018e15f6e9949bab1c1",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log(
    "[firebase-messaging-sw.js] Received background message ",
    payload,
  );
  const notificationTitle =
    payload.notification?.title || payload.data?.title || "แจ้งเตือนใหม่";
  const notificationOptions = {
    body: payload.notification?.body || payload.data?.body,
    icon: "/app-icon.svg",
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

const CACHE_NAME = 'timetable-cache-v8';
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/app-icon-192.png',
  '/app-icon-512.png',
  '/app-icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(URLS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }
  
  // Bypassing API and Firebase/Firestore network requests from cache
  if (event.request.url.includes('/api/') || event.request.url.includes('firebase') || event.request.url.includes('firestore')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        return caches.open(CACHE_NAME).then((cache) => {
          // Update cache with fresh version
          cache.put(event.request, networkResponse.clone());
          return networkResponse;
        });
      }).catch(() => {
        // Network failed (offline)
        if (event.request.mode === 'navigate') {
          return caches.match('/'); // Return root index.html if navigating
        }
        return null;
      });

      // Return cached response immediately if available, while fetching in background
      return cachedResponse || fetchPromise;
    })
  );
});
