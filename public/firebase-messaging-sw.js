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
    icon: "/icon.svg",
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// PWA Installability requires a fetch handler
self.addEventListener("fetch", function (event) {
  // We don't intercept anything, let the browser handle it.
  // This just satisfies the PWA criteria for Chrome.
});
