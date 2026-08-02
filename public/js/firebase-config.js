import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-analytics.js";

const defaultFirebaseConfig = {
  apiKey: "AIzaSyDGSYkZdTDDj_ucCKjkiC-8WejvdnrVfSQ",
  authDomain: "unitedcb-4845b.firebaseapp.com",
  projectId: "unitedcb-4845b",
  storageBucket: "unitedcb-4845b.firebasestorage.app",
  messagingSenderId: "54110165279",
  appId: "1:54110165279:web:04ddda35bfc2624f87b82a",
  measurementId: "G-HWYB1Q883J"
};

const firebaseConfig = window.__FIREBASE_CONFIG__ || defaultFirebaseConfig;

try {
  const app = initializeApp(firebaseConfig);
  isSupported()
    .then((supported) => {
      if (supported) {
        getAnalytics(app);
      }
    })
    .catch(() => {});
} catch (error) {
  console.warn('Firebase analytics failed to initialise.', error);
}
