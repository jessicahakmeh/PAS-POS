// Firebase init (modular SDK from CDN) + the shared core instance.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import * as fs from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js';
import { createCore } from '../core.js';

const firebaseConfig = {
  apiKey: "AIzaSyBKzu5iUwWngth6OX1h4KA5Vqe9UdaI8zA",
  authDomain: "pos-pas.firebaseapp.com",
  projectId: "pos-pas",
  storageBucket: "pos-pas.firebasestorage.app",
  messagingSenderId: "276340872861",
  appId: "1:276340872861:web:feb7c3762257bcf7332674",
  measurementId: "G-XE272531X6"
};

export const db = fs.getFirestore(initializeApp(firebaseConfig));
export { fs };
export const core = createCore(db, fs);

// Tenant data helpers (all tenant data lives under data/{dataKey}/...)
export const dataColl = (s, name) => fs.collection(db, 'data', s.dataKey, name);
export const dataDoc = (s, name, id) => fs.doc(db, 'data', s.dataKey, name, id);
